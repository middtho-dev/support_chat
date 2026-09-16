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
 child.on('close',code=>{clearTimeout(timer);if(exceeded)return reject(Error('Загрузка превысила лимит времени'));if(code)return reject(Error(/login|sign in|cookies|private|403|429/i.test(error)?'Источник требует входа или ограничил загрузку видео':'Не удалось скачать видео. Проверьте публичность ссылки.'));resolve(output);});
 });}
async function download(job,c,dir,{execute=run,onProgress=()=>{}}={}){
 await fs.mkdir(dir,{recursive:true});
 const disk=await fs.statfs(dir);if(disk.bavail*disk.bsize<256*1024*1024+c.maxMB*3*1024*1024)throw Error('На сервере недостаточно свободного места. Повторите позже.');
 const base=['--ignore-config','--no-playlist','--no-cache-dir','--socket-timeout','15','--retries','1','--js-runtimes','node'];
 onProgress('Получаем сведения о видео…');
 const info=JSON.parse(await execute([...base,'--dump-single-json','--skip-download','--',job.url],30000));
 if(info._type==='playlist'||info.is_live||info.live_status==='is_live')throw Error('Нужна ссылка на одиночный ролик, не плейлист или прямой эфир');
 if(Number.isFinite(Number(info.duration))&&Number(info.duration)>c.maxSeconds)throw Error(`Видео длиннее лимита ${c.maxSeconds} секунд`);
 onProgress('Скачиваем видео…');
 const output=path.join(dir,'video.%(ext)s');
 await execute([...base,'--max-filesize',c.maxMB+'M','-S',`res:${c.height}`,'-f','bv*[ext=mp4][vcodec^=avc]+ba[ext=m4a]/b[ext=mp4]','--merge-output-format','mp4','--newline','--progress','--progress-delta','1','--progress-template','download:KV9PROGRESS:%(progress._percent_str)s','-o',output,'--',job.url],90000,undefined,line=>{const match=line.match(/KV9PROGRESS:\s*(\d+(?:\.\d+)?)%/);if(match)onProgress('Скачиваем видео · '+Math.min(100,Math.floor(Number(match[1])))+'%');});
 onProgress('Проверяем видео и готовим отправку…');
 const file=path.join(dir,'video.mp4'),stat=await fs.stat(file).catch(()=>null);
 if(!stat?.size||stat.size>c.maxMB*1024*1024)throw Error('Видео превышает лимит размера');
 // Instagram often omits duration from metadata. Inspect the actual media
 // instead of rejecting a valid clip or trusting an inaccurate source value.
 const probe=JSON.parse(await execute(['-v','error','-show_entries','format=duration:stream=codec_type','-of','json',file],15000,'ffprobe'));
 const duration=Number(probe.format?.duration);
 if(!probe.streams?.some(s=>s.codec_type==='video')||!Number.isFinite(duration)||duration<=0)throw Error('Не удалось проверить видеофайл');
 if(duration>c.maxSeconds)throw Error(`Видео длиннее лимита ${c.maxSeconds} секунд`);
 await execute(['-nostdin','-y','-i',file,'-frames:v','1','-vf','scale=320:-2',path.join(dir,'thumbnail.jpg')],15000,'ffmpeg');
 onProgress('Отправляем видео в Telegram…');
 return {file,size:stat.size,title:String(info.title||'Видео').slice(0,160),duration:Math.ceil(duration)};
}
module.exports={download};
