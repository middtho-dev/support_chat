'use strict';
const fs=require('fs/promises'),path=require('path'),{spawn}=require('child_process');
function run(args,timeout=90000,binary=process.env.YTDLP_PATH||'yt-dlp'){return new Promise((resolve,reject)=>{
 const child=spawn(binary,args,{shell:false,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
 let output='',error='',exceeded=false;
 const kill=()=>{try{if(process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill();}catch{}};
 const timer=setTimeout(()=>{exceeded=true;kill();},timeout);
 child.stdout.on('data',b=>{output+=b;if(output.length>4*1024*1024){exceeded=true;kill();}});
 child.stderr.on('data',b=>{error=(error+b).slice(-4000);});
 child.on('error',()=>{clearTimeout(timer);reject(Error('Загрузчик видео недоступен'));});
 child.on('close',code=>{clearTimeout(timer);if(exceeded)return reject(Error('Загрузка превысила лимит времени'));if(code)return reject(Error(/login|sign in|cookies|private|403|429/i.test(error)?'Источник требует входа или ограничил загрузку видео':'Не удалось скачать видео. Проверьте публичность ссылки.'));resolve(output);});
 });}
async function download(job,c,dir){
 await fs.mkdir(dir,{recursive:true});
 const disk=await fs.statfs(dir);if(disk.bavail*disk.bsize<256*1024*1024+c.maxMB*3*1024*1024)throw Error('На сервере недостаточно свободного места. Повторите позже.');
 const base=['--ignore-config','--no-playlist','--no-cache-dir','--socket-timeout','15','--retries','1','--js-runtimes','node'];
 const info=JSON.parse(await run([...base,'--dump-single-json','--skip-download','--',job.url],30000));
 if(info._type==='playlist'||!Number.isFinite(info.duration)||info.duration>c.maxSeconds)throw Error('Видео превышает лимит длительности или не является одиночным роликом');
 const output=path.join(dir,'video.%(ext)s');
 await run([...base,'--max-filesize',c.maxMB+'M','-f',`bv*[height<=${c.height}][ext=mp4][vcodec^=avc]+ba[ext=m4a]/b[height<=${c.height}][ext=mp4]`,'--merge-output-format','mp4','--no-progress','-o',output,'--',job.url]);
 const file=path.join(dir,'video.mp4'),stat=await fs.stat(file).catch(()=>null);
 if(!stat?.size||stat.size>c.maxMB*1024*1024)throw Error('Видео превышает лимит размера');
 await run(['-nostdin','-y','-i',file,'-frames:v','1','-vf','scale=320:-2',path.join(dir,'thumbnail.jpg')],15000,'ffmpeg');
 return {file,size:stat.size,title:String(info.title||'Видео').slice(0,160),duration:Math.ceil(info.duration)};
}
module.exports={download};
