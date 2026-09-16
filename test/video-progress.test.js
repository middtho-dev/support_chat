'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {Store}=require('../tools/video/store'),{Worker}=require('../tools/video/worker'),{Progress,limited}=require('../tools/video/progress');
function setup(t,call,download){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-progress-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir,'a'.repeat(64));store.data.config.enabled=true;return new Worker(store,{call,download,publicUrl:'https://example.com'});}
const message={message_id:5,chat:{id:7,type:'private'},from:{id:3},text:'/video https://youtu.be/abcdefghijk',reply_to_message:{message_id:2}};
test('status is created immediately before tick and deletes only the invocation',async t=>{
 const calls=[];const worker=setup(t,async(method,body)=>{calls.push([method,body]);return {message_id:10};},async()=>{throw Error('Source unavailable');});
 worker.accept({update_id:1,message});assert.equal(calls[0][0],'sendRichMessage');await worker.progress.get('1').ready;
 assert.equal(calls[1][0],'deleteMessage');assert.equal(calls[1][1].message_id,5);
 await worker.tick();const edits=calls.filter(c=>c[0]==='editMessageText');assert.equal(edits.at(-1)[1].message_id,10);assert.match(edits.at(-1)[1].rich_message.html,/Source unavailable/);
 assert.equal(calls.filter(c=>c[0].startsWith('send')).length,1);
});
test('deletion denied does not prevent replacing the same message with video',async t=>{
 const calls=[];const worker=setup(t,async(method,body)=>{calls.push([method,body]);if(method==='deleteMessage')throw Error('Forbidden');return {message_id:10};},async()=>{const file=path.join(worker.store.dir,'clip.mp4');fs.writeFileSync(file,'video');return {file,title:'Clip',size:5,duration:1};});
 worker.accept({update_id:2,message});await worker.tick();assert.equal(worker.store.data.jobs[0].status,'done');assert.match(worker.store.data.jobs[0].cleanupWarning,/не удалено/);
 const final=calls.find(c=>c[0]==='editMessageMedia')[1];assert.equal(final.get('message_id'),'10');assert.equal(JSON.parse(final.get('media')).media,'attach://video');
});
test('restart retains a confirmed status and never creates a second one',async t=>{
 const calls=[];const worker=setup(t,async(method,body)=>{calls.push([method,body]);return {inline_message_id:'guest-inline'};},async()=>{throw Error('unavailable');});
 worker.store.data.jobs.push({id:'4',status:'downloading',guest:'q',inlineId:'guest-inline',created:Date.now(),url:'https://youtu.be/abcdefghijk'});worker.store.save();
 const restarted=new Store(worker.store.dir,'a'.repeat(64));worker.store=restarted;await worker.tick();assert.ok(calls.every(c=>c[0]==='editMessageText'));assert.equal(calls[0][1].inline_message_id,'guest-inline');
 restarted.data.jobs.push({id:'5',status:'queued',announcing:true});restarted.save();assert.equal(new Store(worker.store.dir,'a'.repeat(64)).data.jobs.at(-1).status,'uncertain');
});
test('progress coalesces fast changes and respects flood delay',async()=>{
 const calls=[],job={inlineId:'inline'},worker={call:async(method,body)=>{calls.push(body);if(calls.length===1)throw Object.assign(Error('flood'),{retryAfter:2});}};
 const p=new Progress(worker,job);p.update('10%');await new Promise(r=>setTimeout(r,30));p.update('20%');p.update('30%');await new Promise(r=>setTimeout(r,50));assert.equal(calls.length,1);assert.ok(p.next>Date.now()+1000);await p.stop();
 let attempts=0;await limited(async()=>{if(++attempts===1)throw Object.assign(Error('flood'),{code:429,retryAfter:0.001});return true;},'editMessageText',{});assert.equal(attempts,2);
 attempts=0;await assert.rejects(limited(async()=>{attempts++;throw Error('network');},'answerGuestQuery',{}));assert.equal(attempts,1);
});
