'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'history-cursor-'));
process.env.DB_PATH=path.join(root,'test.db');const db=require('../src/database');
test.after(()=>{db.db.close();fs.rmSync(root,{recursive:true,force:true});});
test('stable history cursor returns every message once even when a burst has the same timestamp',()=>{
 db.createTicket.run('burst','Fixture','session');
 for(let i=0;i<137;i++){
  db.saveMessage.run('message-'+i,'burst','user','Fixture','Message '+i,'text',null,null,null,null,null);
  db.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(i<60?'2026-10-29 10:00:00':'2026-10-29 10:00:01','message-'+i);
 }
 let batch=db.getMessagesRecent.all('burst',50),all=[...batch];
 while(batch.length){const cursor=batch[0];batch=db.getMessagesBefore.all('burst',cursor.created_at,cursor.created_at,cursor.sequence,50);all=[...batch,...all];}
 assert.equal(all.length,137);assert.equal(new Set(all.map(m=>m.id)).size,137);
 assert.deepEqual(all.map(m=>m.id),Array.from({length:137},(_,i)=>'message-'+i));
});
test('only newly closed tickets with a pending closure can drain saved manual Telegram replies',()=>{
 for(const id of ['closed-old','closed-new']){
  db.createTicket.run(id,id,'session-'+id);db.db.prepare("UPDATE tickets SET source='telegram',telegram_customer_id=?,telegram_customer_chat_id=? WHERE id=?").run(id,id,id);
  db.saveMessage.run(id+'-reply',id,'support','Operator','Saved','text',null,null,null,null,null);db.closeTicket.run(id);
 }
 const {createTicketClosures}=require('../src/ticket-closures');const closures=createTicketClosures(db.db);closures.enqueue({id:'closed-new'},'Closed');
 const rows=db.getPendingTelegramCustomerReplies.all(100);assert.ok(rows.some(m=>m.ticket_id==='closed-new'));assert.ok(!rows.some(m=>m.ticket_id==='closed-old'));
});
