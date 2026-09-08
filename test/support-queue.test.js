'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),express=require('express');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'support-queue-'));process.env.DB_PATH=path.join(dir,'test.db');const store=require('../src/database'),db=store.db;const {createSupportQueue}=require('../src/support-queue');
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('queue separates closed-ticket backlog, enforces permissions and pauses without deleting history',async()=>{
 db.prepare("INSERT INTO tickets(id,user_name,session_token,status,source,assigned_operator_id,telegram_customer_chat_id) VALUES ('open','Open','open','open','telegram','42','42'),('closed','Closed','closed','closed','telegram','42','42')").run();
 db.prepare("INSERT INTO messages(id,ticket_id,sender,sender_name,content,message_type) VALUES ('live','open','support','Support','Reply','text'),('old','closed','support','Support','Old reply','text')").run();
 store.enqueueTelegramIncomingMessage.run('42',10,JSON.stringify({text:'Incoming'}));db.prepare('UPDATE telegram_incoming_message_queue SET next_retry_at=CURRENT_TIMESTAMP').run();
 let busy=false,wakes=0;const app=express();app.use(express.json());app.use('/queue',createSupportQueue({database:db,authorize:token=>({authenticated:['manager','operator'].includes(token),canManageSettings:token==='manager'}),settings:()=>({telegramEnabled:true}),service:{status:()=>({mode:'private'}),queueBusy:()=>busy,wakeDelivery:()=>wakes++}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port+'/queue';
 const get=(suffix='',token='manager')=>fetch(base+suffix,{headers:{'x-admin-token':token}});
 const action=(kind,id,action,token='manager')=>fetch(base+'/action',{method:'POST',headers:{'x-admin-token':token,'Content-Type':'application/json'},body:JSON.stringify({kind,id,action})});
 try{
 assert.equal((await get('','invalid')).status,401);let list=await(await get()).json();assert.deepEqual(list.counts,{pending:3,blocked:2,paused:0});assert.equal(list.rows.find(r=>r.kind==='incoming').content,'Incoming');assert.ok(!list.rows.some(r=>r.ticket_id==='closed'));assert.ok(list.rows.every(r=>r.blocked_reason===null));
 assert.equal((await action('customer','live','pause','operator')).status,403);assert.equal((await action('customer','old','retry')).status,409);
 busy=true;assert.equal((await action('customer','live','pause')).status,409);busy=false;
 assert.equal((await action('customer','live','pause')).status,200);assert.equal(store.getPendingTelegramCustomerReplies.all(20).length,0);assert.equal(db.prepare('SELECT content FROM messages WHERE id=?').get('live').content,'Reply');assert.equal(store.getNextTelegramCustomerReply.get('open'),undefined);
 list=await(await get('?state=paused')).json();assert.equal(list.counts.paused,1);assert.equal(list.rows[0].id,'live');
 assert.equal((await action('customer','live','retry')).status,200);assert.equal(store.getPendingTelegramCustomerReplies.all(20).length,1);assert.equal(wakes,1);
 assert.equal((await action('operator','live','pause')).status,200);assert.equal(store.getPendingPrivateTelegramMessages.all(20).length,0);assert.equal(store.getPendingTelegramMessages.all(20).some(r=>r.id==='live'),false);
 assert.equal((await action('incoming','42:10','pause')).status,200);assert.equal(store.getPendingTelegramIncomingMessages.all(20).length,0);assert.ok(store.getTelegramIncomingMessage.get('42',10));
 assert.equal((await action('incoming','42:10','retry')).status,200);assert.equal(store.getPendingTelegramIncomingMessages.all(20).length,1);
 assert.equal((await action('customer','old','pause')).status,200);const beforeRestore=wakes;assert.equal((await action('customer','old','restore')).status,200);assert.equal(wakes,beforeRestore);assert.equal(store.deliveryHeld.get('customer','old'),undefined);
 assert.equal((await action('operator','missing','pause')).status,404);assert.equal((await action('x','live','pause')).status,400);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
