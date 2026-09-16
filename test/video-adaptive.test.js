'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs/promises'),os=require('os'),path=require('path');
const {download,fitVideo}=require('../tools/video/download');
const MB=1024*1024,c={height:720,maxMB:5,maxSeconds:60},job={url:'https://www.instagram.com/reel/sample/'};
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'adaptive-video-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'video.mp4');return {dir,file};}
async function sized(file,bytes){await fs.writeFile(file,'');await fs.truncate(file,bytes);}
const probe=duration=>JSON.stringify({format:{duration},streams:[{codec_type:'video',width:720,height:1280},{codec_type:'audio'}]});
test('oversized download falls back to a smaller source without transcoding',async t=>{
 const {dir,file}=await fixture(t),resolutions=[];
 const execute=async(args,timeout,binary)=>{
  if(args.includes('--dump-single-json'))return JSON.stringify({duration:20,title:'Sample'});
  if(args.includes('-o')){resolutions.push(args[args.indexOf('-S')+1]);if(resolutions.length===1)throw Object.assign(Error('size'),{code:'VIDEO_SIZE'});await sized(file,4*MB);}
  if(binary==='ffprobe')return probe(20);
  assert.ok(!args.includes('libx264'));return '';
 };
 const result=await download(job,c,dir,{execute});assert.equal(result.size,4*MB);assert.deepEqual(resolutions,['res:720,size','res:480,size']);
});
test('missing compact formats trigger bounded source download and progressively stronger compression',async t=>{
 const {dir,file}=await fixture(t),rates=[],scales=[];let downloads=0;
 const execute=async(args,timeout,binary)=>{
  if(args.includes('--dump-single-json'))return JSON.stringify({duration:20});
  if(args.includes('-o')){downloads++;if(args[args.indexOf('--max-filesize')+1]==='5M')return '';await sized(file,8*MB);}
  if(binary==='ffprobe')return probe(20);
  if(args.includes('libx264')){rates.push(parseInt(args[args.indexOf('-b:v')+1]));scales.push(args[args.indexOf('-vf')+1]);await sized(file,(rates.length===1?6:4)*MB);}
  return '';
 };
 const result=await download(job,c,dir,{execute});assert.equal(result.size,4*MB);assert.equal(result.duration,20);assert.equal(downloads,5);assert.equal(rates.length,2);assert.ok(rates[1]<rates[0]);assert.match(scales[0],/720/);assert.match(scales[1],/480/);await assert.rejects(fs.stat(path.join(dir,'source.mp4')));
});
test('compression must preserve duration and audio, not merely file size',async t=>{
 for(const invalid of ['short','silent']){
  const {dir,file}=await fixture(t);await sized(file,8*MB);let encoded=false;
  const execute=async(args,timeout,binary)=>{if(binary==='ffprobe'){const data=JSON.parse(probe(encoded&&invalid==='short'?3:20));if(encoded&&invalid==='silent')data.streams.pop();return JSON.stringify(data);}encoded=true;await sized(file,MB);return '';};
  await assert.rejects(fitVideo(file,c,dir,{execute}),invalid==='short'?/неполный/:/звуковая/);
 }
});
test('terminal size error is returned only after every compression level was tried',async t=>{
 const {dir,file}=await fixture(t);await sized(file,8*MB);let attempts=0;
 const execute=async(args,timeout,binary)=>{if(binary==='ffprobe')return probe(20);attempts++;await sized(file,6*MB);return '';};
 await assert.rejects(fitVideo(file,c,dir,{execute}),/даже после/);assert.equal(attempts,4);
});
test('unrelated source failures are not retried as size problems',async t=>{
 const {dir}=await fixture(t);let downloads=0;
 const execute=async(args)=>{if(args.includes('--dump-single-json'))return '{}';downloads++;throw Object.assign(Error('private video'),{code:'VIDEO_DOWNLOAD'});};
 await assert.rejects(download(job,c,dir,{execute}),/private/);assert.equal(downloads,1);
});
