'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {defaults,validate,selectMessage}=require('../config'),{Store}=require('../store'),{Worker}=require('../worker'),{createServer}=require('../server');
const conn={id:'business',user:{id:777},is_enabled:true,rights:{can_reply:true,can_delete_all_messages:true}};
const msg={business_connection_id:'business',date:Math.floor(Date.now()/1000),message_id:10,chat:{id:888,type:'private'},from:{id:888},voice:{file_id:'file',duration:12,file_size:100}};
const {deleteFields,responseBody}=require('../formatting');
test('legacy deletion migrates without changing preferences and new switches survive restart',t=>{
 const {store,dir}=fixture(t);
 for(const legacy of [false,true]){
  for(const key of deleteFields)delete store.data.config[key];
  store.data.config.deleteOriginal=legacy;store.save();
  const restored=new Store(dir,'a'.repeat(64));
  for(const key of deleteFields)assert.equal(restored.data.config[key],legacy);
  restored.data.config.deleteIncomingVoice=!legacy;restored.save();
  assert.equal(new Store(dir,'a'.repeat(64)).data.config.deleteIncomingVoice,!legacy);
 }
 assert.ok(deleteFields.every(k=>validate({deleteOriginal:true})[k]));
 assert.equal(validate({deleteOriginal:true,deleteIncomingVoice:false}).deleteIncomingVoice,false);
});
test('each deletion switch affects only its media type and direction after delivery',async t=>{
 for(const selected of deleteFields)for(const kind of ['voice','video_note','audio'])for(const outgoing of [false,true]){
  const {store}=fixture(t);Object.assign(store.data.config,{direction:'both',voice:true,videoNote:true,audio:true,...Object.fromEntries(deleteFields.map(k=>[k,k===selected]))});
  const calls=[];const worker=new Worker(store,{telegram:async method=>{calls.push(method);return method==='getBusinessConnection'?conn:{message_id:20};},transcribe:async()=> 'Text',polish:async x=>x});
  await worker.ingest({update_id:1,business_message:{...msg,voice:undefined,from:{id:outgoing?777:888},[kind]:msg.voice}});
  await worker.process(store.data.jobs[0]);
  const expected='delete'+(outgoing?'Outgoing':'Incoming')+({voice:'Voice',video_note:'VideoNote',audio:'Audio'}[kind]);
  assert.equal(store.data.jobs[0].status,'done');
  assert.deepEqual(calls,selected===expected?['getBusinessConnection','sendMessage','deleteBusinessMessages']:['getBusinessConnection','sendMessage']);
 }
});
test('emoji formatting works independently and reasoning is sent only to compatible models',async t=>{
 const {store}=fixture(t);let formats=0;
 const worker=new Worker(store,{polish:async text=>{formats++;return text+' ☕';}});
 assert.equal(await worker.polish('Кофе',{...defaults,polish:false,emoji:false}),'Кофе');
 assert.equal(await worker.polish('Кофе',{...defaults,polish:false,emoji:true}),'Кофе ☕');assert.equal(formats,1);
 const body=responseBody('Пример',{...defaults,polish:false,emoji:true,formatModel:'gpt-5.4-nano'});
 assert.deepEqual(body.reasoning,{effort:'none'});assert.match(body.instructions,/Редактирование выключено/);assert.match(body.instructions,/ВНУТРИ текста/);
 assert.equal(responseBody('Пример',{...defaults,formatModel:'gpt-4.1-mini'}).reasoning,undefined);
 assert.throws(()=>validate({emojiPlacement:'unknown'}));assert.throws(()=>validate({outputTokens:0}));
});
test('preview uses unsaved formatting only, requires authentication and never changes stored settings',async t=>{
 const {store}=fixture(t);let seen;
 const worker=new Worker(store,{polish:async(text,c)=>{seen=c;return text+' ☕';},telegram:async()=>{throw Error('Preview must not send Telegram messages');}});
 const server=createServer(store,worker,'service-key');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+server.address().port+'/api/voice/preview',before=structuredClone(store.data.config);
 const payload={text:'Кофе',settings:{formatModel:'gpt-5.4-nano',polish:false,emoji:true,openaiKey:'do-not-accept',deleteIncomingVoice:false}};
 assert.equal((await fetch(url,{method:'POST',body:JSON.stringify(payload)})).status,401);
 const r=await fetch(url,{method:'POST',headers:{'x-admin-token':'service-key'},body:JSON.stringify(payload)});
 assert.equal(r.status,200);assert.equal((await r.json()).text,'Кофе ☕');assert.equal(seen.formatModel,'gpt-5.4-nano');
 assert.equal(seen.openaiKey,before.openaiKey);assert.equal(seen.deleteIncomingVoice,before.deleteIncomingVoice);assert.deepEqual(store.data.config,before);
});
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir,'a'.repeat(64));store.data.config={...defaults,enabled:true,ownerIds:'777',botToken:'777:example-secret-token-long-enough',openaiKey:'example-openai-secret',deleteOriginal:true,deleteIncomingVoice:true};store.data.connections.business=structuredClone(conn);return {store,dir};}
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
test('queued work completes while Telegram long polling is still waiting',async t=>{
 const {store}=fixture(t);store.data.config.polish=false;store.data.config.deleteOriginal=false;store.data.config.deleteIncomingVoice=false;
 let releasePoll,resolveDelivered;const delivered=new Promise(r=>resolveDelivered=r);let polls=0,sends=0;
 const worker=new Worker(store,{telegram:async method=>{
   if(method==='getUpdates'){polls++;return new Promise(r=>releasePoll=r);}
   if(method==='getBusinessConnection')return conn;
   if(method==='sendMessage'){if(++sends===2)resolveDelivered();return {message_id:20};}
 },transcribe:async()=> 'Текст',polish:async()=>{throw Error('Fast mode must skip polishing');}});
 await worker.ingest({update_id:1,business_message:msg});await worker.ingest({update_id:2,business_message:{...msg,message_id:11}});
 const running=worker.run();let timeout;
 try{await Promise.race([delivered,new Promise((_,reject)=>timeout=setTimeout(()=>reject(Error('Queue blocked by polling')),2000))]);}
 finally{clearTimeout(timeout);worker.stopped=true;releasePoll?.([]);await running;}
 assert.equal(polls,1);assert.equal(sends,2);assert.ok(store.data.jobs.every(j=>j.status==='done'&&j.finishedAt&&j.timings.audio>=0));
});
test('deleting an original during transcription cancels delivery',async t=>{
 const {store}=fixture(t);let release,started;const ready=new Promise(r=>started=r);let sends=0;
 const worker=new Worker(store,{telegram:async()=>{sends++;return conn;},transcribe:async()=>{started();return new Promise(r=>release=r);}});
 await worker.ingest({update_id:1,business_message:msg});const processing=worker.process(store.data.jobs[0]);await ready;
 await worker.ingest({update_id:2,deleted_business_messages:{business_connection_id:'business',chat:msg.chat,message_ids:[10]}});release('Текст');await processing;
 assert.equal(store.data.jobs[0].status,'cancelled');assert.equal(sends,0);
});
test('exhausted API credit is actionable and does not schedule pointless retries',async t=>{
 const {openaiError}=require('../worker');const {store}=fixture(t);
 const error=await openaiError(new Response(JSON.stringify({error:{code:'credit_balance_exhausted'}}),{status:429}));
 assert.equal(error.retryable,false);assert.match(error.message,/средства/);
 const worker=new Worker(store,{transcribe:async()=>{throw error;}});await worker.ingest({update_id:1,business_message:msg});await worker.process(store.data.jobs[0]);
 assert.equal(store.data.jobs[0].status,'failed');assert.equal(store.data.jobs[0].attempts,1);
});
