'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'dialog-state-'));process.env.DB_PATH=path.join(root,'support.db');
const db=require('../src/database'),{createSupportDialogs}=require('../src/telegram-support-dialogs');
let now=Date.now(),id=1000,failSend=false,failDelete=false,blockSend=null,announce=null;const effects=[];
const options={db,enabled:()=>true,authorized:()=>true,clock:()=>now,
  model:t=>({markdown:t.id,fallback:t.id}),keyboard:()=>({inline_keyboard:[]}),
  send:async(chat,text,opts)=>{if(announce)announce();if(blockSend)await blockSend;if(failSend)throw Error('offline');const message_id=++id;effects.push({kind:'send',id:message_id,chat,opts});return {message_id};},
  edit:async()=>true,remove:async(chat,id)=>{if(failDelete)return false;effects.push({kind:'delete',id});return true;},
  removeTopic:async()=>{},expired:()=>false,retryDelay:()=>1,errorText:e=>e.message,onError:()=>{}};
let dialogs=createSupportDialogs(options);
function ticket(name){db.createTicket.run(name,name,'session-'+name);db.upsertTelegramOperator.run('7001','Оператор',null);db.assignTicketIfUnassigned.run('7001',name);return db.getTicketById.get(name);}
function question(t,name){db.saveMessage.run(name,t.id,'user','Клиент',name,'text',null,null,null,null,null);}
const row=t=>dialogs.get(t.id,'7001');
test.after(()=>{db.db.close();fs.rmSync(root,{recursive:true,force:true});});

test('concurrent refreshes serialize into one card and one notification',async()=>{
  const t=ticket('concurrent');question(t,'q-concurrent');
  await Promise.all(Array.from({length:12},()=>dialogs.sync(t,'7001',{notify:true})));
  const cards=db.db.prepare("SELECT * FROM telegram_operator_dialog_messages WHERE ticket_id=? AND kind='card' AND cleanup=0").all(t.id);
  assert.equal(cards.length,1);assert.equal(effects.filter(e=>e.kind==='send').length,1);assert.equal(effects[0].opts.disable_notification,false);
});

test('failed old-card deletion prevents duplicate cards; retry preserves queued notification',async()=>{
  const t=ticket('delete-retry');question(t,'q-delete-1');await dialogs.sync(t,'7001',{notify:true});const old=row(t).message_id;
  now+=4000;question(t,'q-delete-2');failDelete=true;
  await assert.rejects(()=>dialogs.sync(t,'7001',{notify:true}),/old card/);assert.equal(row(t).message_id,old);assert.equal(row(t).dirty,1);
  failDelete=false;now+=2000;await dialogs.retry();assert.notEqual(row(t).message_id,old);
  assert.ok(effects.some(e=>e.kind==='delete'&&e.id===old));
});

test('restart recovers after old-card deletion followed by failed replacement send',async()=>{
  const t=ticket('restart');question(t,'q-restart-1');await dialogs.sync(t,'7001',{notify:true});const old=row(t).message_id;
  now+=4000;question(t,'q-restart-2');failSend=true;
  await assert.rejects(()=>dialogs.sync(t,'7001',{notify:true}),/offline/);assert.equal(row(t).message_id,null);
  failSend=false;dialogs=createSupportDialogs(options);now+=2000;await dialogs.retry();assert.ok(row(t).message_id);assert.notEqual(row(t).message_id,old);
  assert.equal(dialogs.target({chat:{id:7001},from:{id:7001},reply_to_message:{message_id:old}}).ticket_id,t.id,'Reply aliases survive replacement and restart');
});

test('close racing an in-flight Telegram send never leaves an orphan dialog',async()=>{
  const t=ticket('close-race');question(t,'q-race');let release,started;
  const waiting=new Promise(r=>{started=r;});announce=()=>started();blockSend=new Promise(r=>{release=r;});
  const render=dialogs.sync(t,'7001',{notify:true});await waiting;announce=null;
  db.closeTicket.run(t.id);const closing=dialogs.close(db.getTicketById.get(t.id));release();blockSend=null;
  await Promise.all([render,closing]);assert.equal(row(t).message_id,null);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM telegram_operator_dialog_messages WHERE ticket_id=? AND cleanup=0').get(t.id).n,0);
});

test('answered burst cancels deferred notification instead of notifying about an answered question',async()=>{
  const t=ticket('answered-burst');question(t,'q-burst-1');await dialogs.sync(t,'7001',{notify:true});
  question(t,'q-burst-2');await dialogs.sync(t,'7001',{notify:true});const before=effects.filter(e=>e.kind==='send').length;
  db.saveMessage.run('burst-answer',t.id,'support','Оператор','Ответ','text',null,null,null,null,null);
  now+=4000;await dialogs.retry();assert.equal(effects.filter(e=>e.kind==='send').length,before);assert.equal(row(t).notify,0);
});

test('daily quiet replacement keeps long-lived cards within Telegram deletion window',async()=>{
  const t=ticket('daily');question(t,'q-daily');await dialogs.sync(t,'7001',{notify:true});const old=row(t).message_id;
  now+=25*60*60*1000;await dialogs.retry();assert.notEqual(row(t).message_id,old);
  assert.equal(effects.findLast(e=>e.kind==='send').opts.disable_notification,true);
});

test('closed-ticket cleanup remains durable across manager restart',async()=>{
  const t=ticket('cleanup-restart');question(t,'q-cleanup');await dialogs.sync(t,'7001',{notify:true});const card=row(t).message_id;
  dialogs.remember('7001',9000,t.id,'7001','preview');db.closeTicket.run(t.id);failDelete=true;
  await dialogs.close(db.getTicketById.get(t.id));assert.equal(row(t).message_id,null);assert.ok(dialogs.diagnostics().cleanupPending>=2);
  dialogs=createSupportDialogs(options);failDelete=false;now+=2000;await dialogs.retry();
  assert.ok(effects.some(e=>e.kind==='delete'&&e.id===card));assert.ok(effects.some(e=>e.kind==='delete'&&e.id===9000));
  assert.equal(db.getMessages.all(t.id).length,1);
});
