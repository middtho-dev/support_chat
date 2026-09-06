'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {defaults,validate,selectMessage}=require('../config'),{Store}=require('../store'),{Worker}=require('../worker'),{createServer}=require('../server');
const conn={id:'business',user:{id:777},is_enabled:true,rights:{can_reply:true,can_delete_all_messages:true}};
const msg={business_connection_id:'business',date:Math.floor(Date.now()/1000),message_id:10,chat:{id:888,type:'private'},from:{id:888},voice:{file_id:'file',duration:12,file_size:100}};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir,'a'.repeat(64));store.data.config={...defaults,enabled:true,ownerIds:'777',botToken:'777:example-secret-token-long-enough',openaiKey:'example-openai-secret',deleteOriginal:true};store.data.connections.business=structuredClone(conn);return {store,dir};}
test('filters protect owners, directions, media, duration and chat exclusions',()=>{
 const c={...defaults,enabled:true,ownerIds:'777'};
 assert.ok(selectMessage(c,conn,msg));assert.equal(selectMessage({...c,ownerIds:'999'},conn,msg),null);assert.equal(selectMessage({...c,direction:'outgoing'},conn,msg),null);
 assert.equal(selectMessage({...c,excludeChatIds:'888'},conn,msg),null);assert.equal(selectMessage({...c,chatMode:'allow',chatIds:'555'},conn,msg),null);
 assert.equal(selectMessage({...c,maxSeconds:5},conn,msg),null);assert.equal(selectMessage(c,conn,{...msg,sender_business_bot:{id:1}}),null);
 assert.throws(()=>validate({enabled:true}),/ключа/);assert.throws(()=>validate({maxSeconds:90000}));
});
test('secrets are encrypted, masked and authenticated on restart',t=>{
 const {store,dir}=fixture(t);store.save();const text=fs.readFileSync(store.file,'utf8');assert.ok(!text.includes('example-openai-secret'));assert.ok(!JSON.stringify(store.status()).includes('example-openai-secret'));
 assert.equal(new Store(dir,'a'.repeat(64)).data.config.openaiKey,'example-openai-secret');assert.throws(()=>new Store(dir,'b'.repeat(64)));
});
test('one delivery per update, deletion only after confirmed transcript and formatting',async t=>{
 const {store}=fixture(t);const calls=[];const w=new Worker(store,{telegram:async(method)=>{calls.push(method);return method==='getBusinessConnection'?conn:{message_id:20};},transcribe:async()=> 'Сырой текст',polish:async()=> 'Готовый текст'});
 await w.ingest({update_id:1,business_message:msg});await w.ingest({update_id:1,business_message:msg});assert.equal(store.data.jobs.length,1);
 await w.process(store.data.jobs[0]);assert.equal(store.data.jobs[0].status,'done');assert.deepEqual(calls,['getBusinessConnection','sendMessage','deleteBusinessMessages']);
});
test('ambiguous delivery never deletes original or automatically resends after restart',async t=>{
 const {store,dir}=fixture(t);const calls=[];const w=new Worker(store,{telegram:async method=>{calls.push(method);if(method==='getBusinessConnection')return conn;throw Error('timeout');},transcribe:async()=> 'Текст',polish:async x=>x});
 await w.ingest({update_id:2,business_message:msg});await w.process(store.data.jobs[0]);assert.equal(store.data.jobs[0].status,'uncertain');assert.ok(!calls.includes('deleteBusinessMessages'));
 store.data.jobs[0].status='sending';store.save();assert.equal(new Store(dir,'a'.repeat(64)).data.jobs[0].status,'uncertain');
});
test('cleanup retries do not resend text and revoked owners cancel pending work',async t=>{
 const {store}=fixture(t);let sends=0;const w=new Worker(store,{telegram:async method=>{if(method==='getBusinessConnection')return conn;if(method==='sendMessage'){sends++;return {message_id:1};}throw Error('delete failed');},transcribe:async()=> 'Text',polish:async x=>x});
 await w.ingest({update_id:3,business_message:msg});const job=store.data.jobs[0];await w.process(job);await w.process(job);await w.process(job);assert.equal(job.status,'done');assert.equal(sends,1);assert.match(job.error,/оригинал сохранён/);
 await w.ingest({update_id:4,business_message:{...msg,message_id:11}});store.data.config.ownerIds='999';await w.process(store.data.jobs[1]);assert.equal(store.data.jobs[1].status,'cancelled');
});
test('service requires key, refuses active edits and never exposes credentials',async t=>{
 const {store}=fixture(t);const worker=new Worker(store);const server=createServer(store,worker,'service-key');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/api/voice';
 assert.equal((await fetch(url)).status,401);const r=await fetch(url,{headers:{'x-admin-token':'service-key'}});assert.equal(r.status,200);assert.ok(!(await r.text()).includes('example-openai-secret'));
 assert.equal((await fetch(url+'/configure',{method:'POST',headers:{'x-admin-token':'service-key'},body:JSON.stringify({emoji:true})})).status,400);
});
test('quota, removed originals and retention are persisted without processing audio',async t=>{
 const {store,dir}=fixture(t);store.data.config.dailyMinutes=1;
 const worker=new Worker(store);
 await worker.ingest({update_id:5,business_message:{...msg,voice:{...msg.voice,duration:60}}});
 await worker.ingest({update_id:6,business_message:{...msg,message_id:11}});
 assert.equal(store.data.jobs[1].status,'skipped');
 await worker.ingest({update_id:7,deleted_business_messages:{business_connection_id:'business',chat:msg.chat,message_ids:[10]}});
 assert.equal(store.data.jobs[0].status,'cancelled');
 store.data.jobs.forEach(j=>j.created=Date.now()-200*3600000);store.data.config.enabled=false;store.save();worker.prune();
 assert.equal(new Store(dir,'a'.repeat(64)).data.jobs.length,0);
});
