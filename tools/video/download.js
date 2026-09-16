'use strict';
const fs=require('fs/promises'),path=require('path'),{spawn}=require('child_process');
function run(args,timeout=90000,binary=process.env.YTDLP_PATH||'yt-dlp',onLine=()=>{}){return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let output='',error='',exceeded=false;
 const pending={out:'',err:''};
 const lines=(b,key)=>{pending[key]+=b.toString();const parts=pending[key].split(/\r?\n/);pending[key]=parts.pop().slice(-4000);for(const line of parts)onLine(line);};
 const kill=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill();}catch{}};
 const timer=setTimeout(()=>{exceeded=true;kill();},timeout);
 child.stdout.on('data',b=>{lines(b,'out');output+=b;if(output.length>4*1024*1024){exceeded=true;kill();}});
 child.stderr.on('data',b=>{lines(b,'err');error=(error+b).slice(-4000);});
 child.on('error',()=>{clearTimeout(timer);reject(Error('Загрузчик видео недоступен'));});
 child.on('close',code=>{clearTimeout(timer);if(exceeded)return reject(Error('Загрузка превысила лимит времени'));if(code){const size=/max-filesize|larger than.*size|File is too large/i.test(error+output),format=/Requested format is not available/i.test(error);return reject(Object.assign(Error(size?'Видео превышает лимит размера':/login|sign in|cookies|private|403|429/i.test(error)?'Источник требует входа или ограничил загрузку видео':'Не удалось обработать видео. Проверьте публичность ссылки.'),{code:size?'VIDEO_SIZE':format?'VIDEO_FORMAT':'VIDEO_DOWNLOAD'}));}resolve(output);});
 });}
const MB=1024*1024;
const qualitySteps=height=>[...new Set([height,...[720,480,360,240].filter(n=>n<height)])];
async function inspect(file,c,execute){
 const probe=JSON.parse(await execute(['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',file],15000,'ffprobe'));
 const duration=Number(probe.format?.duration);
 if(!probe.streams?.some(s=>s.codec_type==='video')||!Number.isFinite(duration)||duration<=0)throw Error('Не удалось проверить видеофайл');
 if(duration>c.maxSeconds)throw Error(`Видео длиннее лимита ${c.maxSeconds} секунд`);
 return {duration,probe};
}
async function fitVideo(file,c,dir,{execute=run,onProgress=()=>{}}={}){
 const limit=c.maxMB*MB,source=await inspect(file,c,execute);
 if((await fs.stat(file)).size<=limit)return source;
 const original=path.join(dir,'source.mp4');await fs.rename(file,original);
 const steps=qualitySteps(c.height);
 try{
  for(let index=0;index<steps.length;index++){
   const height=steps[index],audio=index<2?64:32;
   const rate=Math.max(32,Math.floor(limit*8/source.duration/1000*(0.9-index*0.07)-audio));
   onProgress(`Уменьшаем видео · ${height}p · попытка ${index+1}/${steps.length}`);
   // Bound the shorter side, preserve portrait videos and never upscale.
   const scale=`scale=w='trunc(iw*min(1,${height}/min(iw,ih))/2)*2':h='trunc(ih*min(1,${height}/min(iw,ih))/2)*2',setsar=1`;
   await execute(['-nostdin','-y','-v','error','-threads','1','-filter_threads','1','-protocol_whitelist','file,pipe','-i',original,'-map','0:v:0','-map','0:a:0?','-sn','-dn','-vf',scale,'-c:v','libx264','-preset','veryfast','-threads','1','-b:v',rate+'k','-maxrate',rate+'k','-bufsize',(rate*2)+'k','-pix_fmt','yuv420p','-c:a','aac','-b:a',audio+'k','-movflags','+faststart','-progress','pipe:1',file],180000,'ffmpeg',line=>{
    const match=line.match(/^out_time_us=(\d+)$/);if(match)onProgress(`Уменьшаем видео · ${height}p · ${Math.min(99,Math.floor(Number(match[1])/1000000/source.duration*100))}%`);
   });
   const result=await inspect(file,c,execute);
   if(Math.abs(result.duration-source.duration)>Math.max(1,source.duration*0.01))throw Error('Сжатие вернуло неполный ролик');
   if(source.probe.streams.some(s=>s.codec_type==='audio')&&!result.probe.streams.some(s=>s.codec_type==='audio'))throw Error('При сжатии потерялась звуковая дорожка');
   if((await fs.stat(file)).size<=limit)return result;
  }
  throw Error('Не удалось уменьшить видео до лимита даже после снижения качества и разрешения');
 }finally{await fs.rm(original,{force:true});}
}
async function download(job,c,dir,{execute=run,onProgress=()=>{}}={}){
 await fs.mkdir(dir,{recursive:true});
 let sourceMB=192;
 const disk=await fs.statfs(dir);if(disk.bavail*disk.bsize<256*MB+c.maxMB*3*MB)throw Error('На сервере недостаточно свободного места. Повторите позже.');
 const base=['--ignore-config','--no-playlist','--no-cache-dir','--socket-timeout','15','--retries','1','--js-runtimes','node'];
 onProgress('Получаем сведения о видео…');
 const info=JSON.parse(await execute([...base,'--dump-single-json','--skip-download','--',job.url],30000));
 if(info._type==='playlist'||info.is_live||info.live_status==='is_live')throw Error('Нужна ссылка на одиночный ролик, не плейлист или прямой эфир');
 if(Number.isFinite(Number(info.duration))&&Number(info.duration)>c.maxSeconds)throw Error(`Видео длиннее лимита ${c.maxSeconds} секунд`);
 const output=path.join(dir,'video.%(ext)s'),file=path.join(dir,'video.mp4');
 const clear=async()=>{for(const name of await fs.readdir(dir))if(name.startsWith('video.'))await fs.rm(path.join(dir,name),{force:true});};
 const fetchVideo=async(height,maxMB)=>{
  await clear();
  await execute([...base,'--max-filesize',maxMB+'M','-S',`res:${height},size`,'-f','bv*[ext=mp4][vcodec^=avc]+ba[ext=m4a]/b[ext=mp4]','--merge-output-format','mp4','--newline','--progress','--progress-delta','1','--progress-template','download:KV9PROGRESS:%(progress._percent_str)s','-o',output,'--',job.url],90000,undefined,line=>{const match=line.match(/KV9PROGRESS:\s*(\d+(?:\.\d+)?)%/);if(match)onProgress('Скачиваем видео · '+Math.min(100,Math.floor(Number(match[1])))+'%');});
  const stat=await fs.stat(file).catch(()=>null);
  if(!stat?.size)throw Object.assign(Error('Видео превышает лимит размера'),{code:'VIDEO_SIZE'});
  return stat.size;
 };
 let found=false;
 for(const [index,height] of qualitySteps(c.height).entries()){
  onProgress(index?`Ищем компактный вариант · ${height}p…`:'Скачиваем видео…');
  try{if(await fetchVideo(height,c.maxMB)<=c.maxMB*MB){found=true;break;}}
  catch(e){if(!['VIDEO_SIZE','VIDEO_FORMAT'].includes(e.code))throw e;}
 }
 if(!found){
  const free=await fs.statfs(dir);sourceMB=Math.min(sourceMB,Math.floor((free.bavail*free.bsize-256*MB)/(6*MB)));
  if(sourceMB<c.maxMB)throw Error('Недостаточно свободного места для сжатия видео');
  onProgress('Готового компактного варианта нет · загружаем для сжатия…');
  try{await fetchVideo(qualitySteps(c.height).at(-1),sourceMB);}catch(e){if(e.code==='VIDEO_SIZE')throw Error('Исходник слишком большой даже в минимальном качестве; автоматическое сжатие недоступно');throw e;}
 }
 onProgress('Проверяем видео и готовим отправку…');
 const {duration}=await fitVideo(file,c,dir,{execute,onProgress});
 await execute(['-nostdin','-y','-i',file,'-frames:v','1','-vf','scale=320:-2',path.join(dir,'thumbnail.jpg')],15000,'ffmpeg');
 onProgress('Отправляем видео в Telegram…');
 return {file,size:(await fs.stat(file)).size,title:String(info.title||'Видео').slice(0,160),duration:Math.ceil(duration)};
}
module.exports={download,fitVideo,qualitySteps};
