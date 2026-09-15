const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {Store}=require('../store'),{Worker}=require('../worker'),{readTranscript}=require('../transcript-stream');
function fixture(t,adapters={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-progress-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir,'a'.repeat(64));Object.assign(store.data.config,{enabled:true,ownerIds:'1',earlyText:true,richMessages:true,polish:true});
 const conn={id:'c',is_enabled:true,user:{id:1},rights:{can_reply:true,can_delete_all_messages:true}};store.data.connections.c=conn;
 const job={id:'j',connectionId:'c',chatId:2,messageId:3,senderId:2,fileId:'f',kind:'voice',seconds:4,status:'pending',created:Date.now(),attempts:0};store.data.jobs.push(job);
 const calls=[];let next=100;
 const worker=new Worker(store,{transcribe:async()=> 'Исходный текст',polish:async()=>{calls.push({method:'polish'});return 'Красивый текст';},telegram:async(method,body)=>{calls.push({method,body});return method==='getBusinessConnection'?conn:{message_id:++next};},...adapters});
 return {worker,job,store,calls,dir,conn};
}
test('early Rich text is sent before polishing and final text edits the same account message',async t=>{
 const {worker,job,calls}=fixture(t);await worker.process(job);
 assert.equal(job.status,'done');const send=calls.findIndex(c=>c.method==='sendRichMessage'),polish=calls.findIndex(c=>c.method==='polish');
 assert.ok(send>=0&&send<polish);const edit=calls.find(c=>c.method==='editMessageText');assert.equal(edit.body.message_id,job.outputIds[0]);assert.equal(edit.body.business_connection_id,'c');assert.match(edit.body.rich_message.html,/Красивый/);
 assert.equal(calls.filter(c=>c.method==='sendRichMessage').length,1);assert.ok(job.firstTextMs>=0);
});
test('explicit Rich rejection falls back to ordinary account text; ambiguous send never falls back',async t=>{
 for(const ambiguous of [false,true]){
  const f=fixture(t);const original=f.worker.adapters.telegram;
  f.worker.adapters.telegram=async(method,body)=>{if(method==='sendRichMessage'){const e=Error('failure');if(!ambiguous){e.code=400;e.richUnavailable=true;}throw e;}return original(method,body);};
  await f.worker.process(f.job);
  assert.equal(f.job.status,ambiguous?'uncertain':'done');assert.equal(f.calls.some(c=>c.method==='sendMessage'),!ambiguous);
 }
});
test('formatting failure retains full transcript and original voice',async t=>{
 const f=fixture(t,{polish:async()=>{throw Error('timeout');}});f.store.data.config.deleteIncomingVoice=true;
 await f.worker.process(f.job);assert.equal(f.job.status,'done');assert.match(f.job.error,/Оформление/);assert.ok(!f.calls.some(c=>c.method==='deleteBusinessMessages'));
 assert.match(f.job.outputTexts.join(''),/Исходный текст/);
});
test('stream previews coalesce; cancellation prevents final delivery',async t=>{
 const f=fixture(t);f.worker.adapters.transcribe=async(job,c,onText)=>{await onText('Длинная первая часть расшифровки');await onText('Длинная первая часть расшифровки и ещё текст');job.status='cancelled';return 'готово';};
 await f.worker.process(f.job);assert.equal(f.job.status,'cancelled');assert.equal(f.calls.filter(c=>c.method==='sendRichMessage').length,1);assert.ok(!f.calls.some(c=>c.method==='polish'));
});
test('restart resumes known edits but uncertain sends stay uncertain',async t=>{
 const f=fixture(t);f.job.progressSending=true;f.store.save();assert.equal(new Store(f.dir,'a'.repeat(64)).data.jobs[0].status,'uncertain');
});
test('rate-limited final edit retries the saved result without another send or formatting',async t=>{
 const f=fixture(t),original=f.worker.adapters.telegram;let edits=0;
 f.worker.adapters.telegram=async(method,body)=>{if(method==='editMessageText'&&++edits===1)throw Object.assign(Error('rate limit'),{code:429,retryAfter:4});return original(method,body);};
 await f.worker.process(f.job);assert.equal(f.job.status,'pending');assert.ok(f.job.next>Date.now()+2000);
 await f.worker.process(f.job);assert.equal(f.job.status,'done');assert.equal(f.calls.filter(c=>c.method==='sendRichMessage').length,1);assert.equal(f.calls.filter(c=>c.method==='polish').length,1);
});
test('long formatted results preserve all text and split only at Unicode characters',async t=>{
 const text='👋'.repeat(1900)+' конец',f=fixture(t,{polish:async()=>text});f.store.data.config.prefix='';
 await f.worker.process(f.job);assert.equal(f.job.status,'done');assert.equal(f.job.outputTexts.join(''),text);assert.equal(f.job.outputIds.length,2);
});
test('SSE handles byte-split Unicode and requires a completion event',async()=>{
 const data='data: '+JSON.stringify({type:'transcript.text.delta',delta:'Привет 👋'})+'\n\n'+'data: '+JSON.stringify({type:'transcript.text.done',text:'Привет 👋'})+'\n\n';
 const chunks=Array.from(Buffer.from(data),b=>new Uint8Array([b]));const seen=[];
 const response=new Response(new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(chunk);c.close();}}),{headers:{'content-type':'text/event-stream'}});
 assert.equal(await readTranscript(response,async x=>seen.push(x)),'Привет 👋');assert.deepEqual(seen,['Привет 👋']);
 await assert.rejects(readTranscript(new Response('data: {"type":"transcript.text.delta","delta":"partial"}\n\n',{headers:{'content-type':'text/event-stream'}}),async()=>{}),/прерван/);
});
