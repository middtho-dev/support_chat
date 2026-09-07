'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Worker}=require('../worker'),{defaults,validate}=require('../config');
test('original audio setting requires a boolean',()=>{
  assert.equal(validate({originalAudio:true}).originalAudio,true);
  assert.throws(()=>validate({originalAudio:'true'}));
});
test('disabled original mode and unknown formats retain conversion',async()=>{
  const previous=process.env.FFMPEG_PATH;process.env.FFMPEG_PATH='missing-ffmpeg-original-audio-test';
  try{for(const [originalAudio,ext] of [[false,'ogg'],[true,'unknown']]){
    const c={...defaults,originalAudio};
    const worker=new Worker({data:{config:c}},{telegram:async()=>({file_path:'sample.'+ext})});
    worker.request=async url=>{assert.ok(url.includes('/file/bot'));return new Response('sample');};
    await assert.rejects(worker.transcribe({fileId:'sample'},c),/преобразовать аудио/);
  }}finally{if(previous===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=previous;}
});
for(const ext of ['oga','ogg','mp3','m4a','webm'])test(`original ${ext} bytes reach API without ffmpeg`,async()=>{
  const bytes=Buffer.from('original test audio'),c={...defaults,originalAudio:true};
  const worker=new Worker({data:{config:c}},{telegram:async()=>({file_path:'voice/file.'+ext,file_size:bytes.length})});
  let uploads=0;
  worker.request=async(url,options)=>{
    if(url.includes('/file/bot'))return new Response(bytes);
    uploads++;
    const file=options.body.get('file');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
    assert.equal(file.name,'voice.'+(ext==='oga'?'ogg':ext));
    assert.equal(file.type,ext==='oga'||ext==='ogg'?'audio/ogg':ext==='mp3'?'audio/mpeg':ext==='m4a'?'audio/mp4':'audio/webm');
    return Response.json({text:'Тест'});
  };
  assert.equal(await worker.transcribe({fileId:'sample'},c),'Тест');assert.equal(uploads,1);
});
