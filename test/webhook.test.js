const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const {WebhookInbox,registerWebhook} = require('../tools/voice/webhook');
const secret = 'a'.repeat(48);

test('accepted updates survive restart, retry failures, and ignore redelivery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'webhook-test-'));
  let calls=0;
  let inbox = new WebhookInbox({dir,secret,ready:()=>false,handle:async()=>{}});
  inbox.accept({update_id:12,message:{text:'hello'}});inbox.stop();
  inbox = new WebhookInbox({dir,secret,handle:async()=>{calls++;if(calls===1)throw Error('network');}});
  t.after(()=>{inbox.stop();fs.rmSync(dir,{recursive:true,force:true});});
  await inbox.drain();assert.equal(inbox.status().pending,1);
  const file=path.join(dir,'12.json'),row=JSON.parse(fs.readFileSync(file));row.next=0;inbox.write(file,row);
  await inbox.drain();assert.equal(inbox.status().pending,0);
  inbox.accept({update_id:12});await inbox.drain();assert.equal(calls,2);
  assert.equal(fs.readFileSync(file,'utf8').includes('hello'),false);
});

test('HTTP endpoint authenticates, rejects malformed updates and persists before ACK',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webhook-http-'));
  const inbox=new WebhookInbox({dir,secret,ready:()=>false,handle:async()=>{}});
  const server=http.createServer((req,res)=>inbox.receive(req,res));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{inbox.stop();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`;
  const send=(body,key=secret)=>fetch(url,{method:'POST',headers:{'x-telegram-bot-api-secret-token':key},body});
  assert.equal((await send('{}','wrong')).status,403);
  assert.equal((await send('{')).status,400);
  assert.equal((await send('{"update_id":3}')).status,200);
  assert.equal(inbox.status().pending,1);
  inbox.write=()=>{throw Error('disk full');};
  assert.equal((await send('{"update_id":4}')).status,503);
});

test('registration retains pending updates and refuses another webhook',async()=>{
  const calls=[];
  await registerWebhook(async(method,body)=>{calls.push({method,body});return {url:''};},'https://example.com/hook',secret,['message']);
  assert.equal(calls[1].body.drop_pending_updates,false);
  assert.equal(calls[1].body.secret_token,secret);
  await assert.rejects(registerWebhook(async()=>({url:'https://other.example/hook'}),'https://example.com/hook',secret,['message']));
});

test('UTF-8 message bytes split across HTTP chunks are preserved',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'webhook-utf8-'));
  const inbox=new WebhookInbox({dir,secret,ready:()=>false,handle:async()=>{}});
  t.after(()=>{inbox.stop();fs.rmSync(dir,{recursive:true,force:true});});
  const update={update_id:99,message:{text:'Привет 👋'}};
  const body=Buffer.from(JSON.stringify(update));
  const req={method:'POST',headers:{'x-telegram-bot-api-secret-token':secret},async *[Symbol.asyncIterator](){for(const byte of body)yield Buffer.from([byte]);}};
  const res={end(){}};await inbox.receive(req,res);
  assert.equal(res.statusCode,200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'99.json'),'utf8')).update,update);
});
