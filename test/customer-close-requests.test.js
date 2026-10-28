'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {installCloseRequests,createCustomerCloseRequests,CLOSE_DELAY_MS}=require('../src/customer-close-requests');
function fixture(){
 const sql=new Database(':memory:');sql.exec(`CREATE TABLE tickets(id TEXT PRIMARY KEY,status TEXT DEFAULT 'open',closed_at TEXT,updated_at TEXT);
 CREATE TABLE messages(id TEXT PRIMARY KEY,ticket_id TEXT,sender TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,message_type TEXT);
 INSERT INTO tickets(id) VALUES ('one'),('two');`);installCloseRequests(sql);
 let now=1000000;const manager=()=>createCustomerCloseRequests(sql,{clock:()=>now});
 return {sql,manager,get now(){return now;},advance:ms=>{now+=ms;},message:(id,ticket='one',type='text')=>sql.prepare("INSERT INTO messages(id,ticket_id,sender,message_type) VALUES (?,?,'user',?)").run(id,ticket,type)};
}
test('closure starts after proposal, survives restart and never runs before five minutes',async()=>{
 const f=fixture();try{
  f.message('question');let requests=f.manager();requests.arm('one','prompt',requests.sequence('one'));
  const closed=[];f.advance(CLOSE_DELAY_MS-1);assert.equal(await requests.process(t=>closed.push(t.id)),0);
  requests=f.manager();f.advance(1);assert.equal(await requests.process(t=>closed.push(t.id)),1);
  assert.deepEqual(closed,['one']);assert.equal(requests.get('one').state,'closed');
  assert.equal(f.sql.prepare("SELECT status FROM tickets WHERE id='one'").get().status,'closed');
  assert.equal(await requests.process(t=>closed.push(t.id)),0);
 }finally{f.sql.close();}
});
test('text or attachment at the deadline cancels only that customer request, including equal timestamps',async()=>{
 for(const type of ['text','image','audio','file']){
  const f=fixture();try{
   const requests=f.manager();requests.arm('one','p1',0);requests.arm('two','p2',0);
   f.advance(CLOSE_DELAY_MS);f.message('new-question','one',type);
   assert.equal(requests.get('one').state,'cancelled');const closed=[];
   await requests.process(t=>closed.push(t.id));assert.deepEqual(closed,['two']);
   assert.equal(f.sql.prepare("SELECT status FROM tickets WHERE id='one'").get().status,'open');
  }finally{f.sql.close();}
 }
});
test('an answer arriving during proposal delivery prevents arming; a later proposal gets a new five minutes',async()=>{
 const f=fixture();try{
  const requests=f.manager(),baseline=requests.sequence('one');f.message('racing-answer');
  requests.arm('one','old-prompt',baseline);assert.equal(requests.pending('one'),null);
  f.advance(1000);requests.arm('one','new-prompt',requests.sequence('one'));
  assert.equal(requests.pending('one').deadline,f.now+CLOSE_DELAY_MS);
  f.sql.prepare("UPDATE tickets SET status='closed' WHERE id='one'").run();
  assert.equal(requests.pending('one'),null);assert.equal(requests.arm('one','invalid',1),null);
 }finally{f.sql.close();}
});
test('two processors atomically close a request once',async()=>{
 const f=fixture();try{
  const requests=f.manager();requests.arm('one','p',0);f.advance(CLOSE_DELAY_MS);let notifications=0;
  await Promise.all([requests.process(async()=>{notifications++;await new Promise(r=>setTimeout(r,10));}),f.manager().process(()=>{notifications++;})]);
  assert.equal(notifications,1);
 }finally{f.sql.close();}
});
