'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {videoUrl,extract,validate,defaults}=require('../tools/video/config'),{Store}=require('../tools/video/store'),{Worker}=require('../tools/video/worker');
test('video URLs canonicalize supported links and reject arbitrary destinations',()=>{
 for(const value of ['http://127.0.0.1/a','https://youtube.com.evil/watch?v=abcdefghijk','https://u:p@youtube.com/watch?v=abcdefghijk','https://youtube.com:444/watch?v=abcdefghijk','file:///etc/passwd','https://youtube.com/playlist?list=abc'])assert.equal(videoUrl(value),null);
 assert.equal(videoUrl('https://youtu.be/abcdefghijk?t=12').url,'https://www.youtube.com/watch?v=abcdefghijk');
 assert.equal(extract({text:'@bot',reply_to_message:{text:'https://instagram.com/reel/Abcd/?x=1'}}).source,'instagram');
 assert.equal(extract({entities:[{type:'text_link',url:'https://youtube.com/shorts/abcdefghijk'}]}).source,'youtube');
});
test('public access defaults and bounded settings',()=>{
 assert.equal(defaults.allowEveryone,true);assert.throws(()=>validate({maxMB:500}));assert.throws(()=>validate({enabled:true}));assert.throws(()=>validate({allowEveryone:false}));
 assert.equal(validate({botToken:''},{...defaults,botToken:'123:'+ 'a'.repeat(25)}).botToken,'123:'+ 'a'.repeat(25));
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir,'a'.repeat(64));store.data.config={...defaults,enabled:true,botToken:'123:'+ 'b'.repeat(25)};return store;}
test('guest replies use exactly one guest query response and never chat sendVideo',async t=>{
 const store=fixture(t),calls=[];const worker=new Worker(store,{call:async(...args)=>{calls.push(args);return {inline_message_id:'inline-1'};},download:async()=>({title:'Clip',size:12,duration:5}),publicUrl:'https://example.com'});
 const update={update_id:1,guest_message:{guest_query_id:'q',guest_bot_caller_user:{id:7},chat:{id:8},message_id:4,text:'https://youtu.be/abcdefghijk'}};
 worker.accept(update);worker.accept(update);assert.equal(store.data.jobs.length,1);await worker.tick();assert.equal(calls.filter(c=>c[0]==='answerGuestQuery').length,1);assert.equal(calls[0][1].result.type,'article');const final=calls.find(c=>c[0]==='editMessageMedia');assert.equal(final[1].inline_message_id,'inline-1');assert.match(final[1].media.media,/\/1\/[a-f0-9]{64}\.mp4$/);assert.ok(calls.every(c=>!['sendVideo','deleteMessage'].includes(c[0])));assert.equal(store.data.jobs[0].status,'done');
});
test('ambiguous delivery is not repeated on restart',async t=>{
 const store=fixture(t),worker=new Worker(store,{call:async()=>{throw Error('network');},download:async()=>({title:'Clip',size:12,duration:5}),publicUrl:'https://example.com'});
 worker.accept({update_id:2,guest_message:{guest_query_id:'q',guest_bot_caller_user:{id:7},text:'https://youtu.be/abcdefghijk'}});await worker.tick();assert.equal(store.data.jobs[0].status,'uncertain');store.data.jobs[0].status='sending';store.save();const restarted=new Store(store.dir,'a'.repeat(64));assert.equal(restarted.data.jobs[0].status,'uncertain');assert.ok(!fs.readFileSync(store.file,'utf8').includes(store.data.config.botToken));
});
test('group calls require invocation and hourly limits persist',t=>{
 const store=fixture(t),worker=new Worker(store,{});worker.bot={id:1,username:'clipbot'};store.data.config.perHour=1;
 const message={chat:{id:5,type:'group'},from:{id:9},text:'https://youtu.be/abcdefghijk'};
 worker.accept({update_id:1,message});assert.equal(store.data.jobs.length,0);
 worker.accept({update_id:2,message:{...message,text:'@clipbot '+message.text}});worker.accept({update_id:3,message:{...message,text:'@clipbot '+message.text}});assert.equal(store.data.jobs.length,1);
});
test('service protects administration and temporary file URLs',async t=>{
 const store=fixture(t),{createService}=require('../tools/video/server');
 const svc=createService({VIDEO_DATA_DIR:store.dir,VIDEO_ENCRYPTION_KEY:'a'.repeat(64),VIDEO_SERVICE_TOKEN:'test-service',VIDEO_WEBHOOK_SECRET:'s'.repeat(32),VIDEO_PUBLIC_URL:'https://example.com'});
 await new Promise(r=>svc.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>svc.server.close(r)));const base='http://127.0.0.1:'+svc.server.address().port;
 assert.equal((await fetch(base+'/api/video')).status,401);
 const response=await fetch(base+'/api/video',{headers:{'x-admin-token':'test-service'}}),data=await response.json();assert.equal(data.config.botToken,undefined);
 assert.equal((await fetch(base+'/api/webhooks/telegram/video',{method:'POST',body:'{}'})).status,503);
 const dir=path.join(store.dir,'files','42');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'video.mp4'),'0123456789');
 svc.store.data.jobs.push({id:'42',cap:'b'.repeat(64),expires:Date.now()+60000});
 const url=base+'/api/video/files/42/'+'b'.repeat(64)+'.mp4';const part=await fetch(url,{headers:{range:'bytes=2-4'}});assert.equal(part.status,206);assert.equal(await part.text(),'234');
 svc.store.data.jobs[0].expires=Date.now()-1;assert.equal((await fetch(url)).status,404);
});
