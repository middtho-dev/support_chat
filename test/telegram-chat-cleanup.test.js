const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-cleanup-'));
process.env.DB_PATH=path.join(dir,'test.sqlite');
const db=require('../src/database').db;
const create=require('../src/telegram-chat-cleanup');
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
test('cleanup keeps the menu, other chats, expired messages and retryable failures',async()=>{
 const cleanup=create(db,id=>['101','102'].includes(id));
 const now=Math.floor(Date.now()/1000);
 for(const id of [1,2,3,4])cleanup.track('101',{message_id:id,date:now});
 cleanup.track('101',{message_id:5,date:now-49*3600});
 cleanup.track('102',{message_id:2,date:now});
 const deleted=[];
 const bot={deleteMessage:async(chat,id)=>{deleted.push([chat,id]);if(id===3)throw Error('message cannot be deleted');}};
 const result=await cleanup.clear(bot,'101',1);
 assert.deepEqual(deleted,[['101',4],['101',3],['101',2]]);
 assert.deepEqual(result,{removed:2,failed:1});
 assert.ok(db.prepare('SELECT 1 FROM telegram_operator_chat_log WHERE chat_id=? AND message_id=?').get('101',3));
 await assert.rejects(cleanup.clear(bot,'999',1));
});
test('tracking records media and incoming IDs, not customer chats or drafts',async()=>{
 const cleanup=create(db,id=>id==='201');
 const bot={sendMessage:async()=>({message_id:10}),sendMediaGroup:async()=>[{message_id:11},{message_id:12}]};
 cleanup.attach(bot);await bot.sendMessage('201','text');await bot.sendMediaGroup('201',[]);await bot.sendMessage('999','customer');
 const rows=db.prepare('SELECT message_id FROM telegram_operator_chat_log WHERE chat_id=? ORDER BY message_id').all('201');
 assert.deepEqual(rows.map(r=>r.message_id),[10,11,12]);
 assert.equal(db.prepare('SELECT count(*) AS n FROM telegram_operator_chat_log WHERE chat_id=?').get('999').n,0);
});
test('rate limits stop deletion attempts and retain remaining IDs',async()=>{
 const cleanup=create(db,id=>id==='301');for(const id of [1,2,3])cleanup.track('301',{message_id:id});
 let calls=0;const result=await cleanup.clear({deleteMessage:async()=>{calls++;throw Error('429 Too Many Requests');}},'301',1);
 assert.equal(calls,1);assert.equal(result.failed,2);
});
