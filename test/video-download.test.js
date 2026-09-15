'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs/promises'),os=require('os'),path=require('path');
const {download}=require('../tools/video/download');
async function fixture(t,metadata,actualDuration,streams=[{codec_type:'video'}]){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'video-download-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const calls=[];
 const execute=async(args,timeout,binary)=>{calls.push({args,binary});if(args.includes('--dump-single-json'))return JSON.stringify(metadata);if(binary==='ffprobe')return JSON.stringify({format:{duration:String(actualDuration)},streams});if(args.includes('-o'))await fs.writeFile(path.join(dir,'video.mp4'),'test media');return '';};
 return {dir,calls,execute};
}
const config={maxMB:5,maxSeconds:60,height:720},job={url:'https://www.instagram.com/reel/test/'};
test('Instagram clips with absent duration are checked using downloaded media',async t=>{
 const f=await fixture(t,{_type:'video',title:'Clip'},19.2);const result=await download(job,config,f.dir,{execute:f.execute});assert.equal(result.duration,20);assert.equal(result.title,'Clip');assert.ok(f.calls.some(c=>c.binary==='ffprobe'));assert.ok(f.calls.some(c=>c.binary==='ffmpeg'));
});
test('unknown or inaccurate source duration cannot bypass the duration limit',async t=>{
 for(const metadata of [{_type:'video'},{_type:'video',duration:10}]){const f=await fixture(t,metadata,75);await assert.rejects(download(job,config,f.dir,{execute:f.execute}),/длиннее лимита 60/);assert.ok(!f.calls.some(c=>c.binary==='ffmpeg'));}
});
test('known long videos are rejected before downloading',async t=>{
 const f=await fixture(t,{_type:'video',duration:90},90);await assert.rejects(download(job,config,f.dir,{execute:f.execute}),/длиннее лимита/);assert.equal(f.calls.length,1);
});
test('invalid media, playlists and live streams are not sent',async t=>{
 for(const metadata of [{_type:'playlist'},{_type:'video',is_live:true}]){const f=await fixture(t,metadata,10);await assert.rejects(download(job,config,f.dir,{execute:f.execute}),/одиночный ролик/);assert.equal(f.calls.length,1);}
 const f=await fixture(t,{_type:'video'},20,[{codec_type:'audio'}]);await assert.rejects(download(job,config,f.dir,{execute:f.execute}),/проверить видеофайл/);
});
