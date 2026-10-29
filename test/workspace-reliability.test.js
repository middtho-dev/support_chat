'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {installTicketClosures,createTicketClosures}=require('../src/ticket-closures');
const {operatorView,protectedChange}=require('../src/operator-access');
const {workspaceBackupStatus}=require('../src/workspace-backup-status');
test('closure delivery survives restart, retries errors, respects lease and finishes only after pending replies',async()=>{
 const sql=new Database(':memory:');try{
  sql.exec("CREATE TABLE tickets(id TEXT PRIMARY KEY);INSERT INTO tickets VALUES ('one'),('two')");installTicketClosures(sql);let now=1000;
  const manager=()=>createTicketClosures(sql,{clock:()=>now});let q=manager();q.enqueue({id:'one'},'reason',[7]);q.enqueue({id:'one'},'duplicate',[8]);
  await q.process(async()=>{throw Error('offline');});assert.deepEqual(q.diagnostics(),{pending:1,failed:1});
  q=manager();assert.equal(await q.process(()=>assert.fail('backoff ignored')),0);now+=15000;
  await q.process(()=>false);assert.equal(q.pending('one'),true);now+=5000;
  let sends=0;await Promise.all([q.process(async()=>{sends++;await new Promise(r=>setTimeout(r,10));}),manager().process(()=>{sends++;})]);
  assert.equal(sends,1);assert.equal(q.pending('one'),false);assert.equal(q.get('one').reason,'reason');assert.deepEqual(JSON.parse(q.get('one').extra_ids),[7]);
  q.enqueue({id:'two'},'later');sql.prepare('UPDATE ticket_closure_delivery SET lease_until=? WHERE ticket_id=?').run(now+120000,'two');
  assert.equal(await manager().process(()=>assert.fail('live lease ignored')),0);now+=120000;await manager().process(()=>'superseded');assert.equal(q.get('two').state,'superseded');
 }finally{sql.close();}
});
test('environment owners are clearly protected; ordinary operator flags remain editable',()=>{
 const owners=new Set(['7001']),row={telegram_user_id:'7001',display_name:'Owner',active:0,can_manage_settings:0};
 assert.equal(operatorView(row,owners).active,true);assert.equal(operatorView(row,owners).canManageSettings,true);assert.equal(operatorView(row,owners).protected,true);
 assert.equal(protectedChange({telegramUserId:'7001',active:false,canManageSettings:true},owners),true);
 assert.equal(protectedChange({telegramUserId:'7001',active:true,canManageSettings:true},owners),false);
 assert.equal(operatorView({...row,telegram_user_id:'7002'},owners).active,false);
});
test('workspace backup status rereads atomic replacement, detects overdue/failure, strips private metadata',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-status-')),file=path.join(dir,'status.json'),now=Date.now();
 try{
  assert.equal(workspaceBackupStatus(file).configured,false);
  fs.writeFileSync(file,JSON.stringify({ok:true,verified:true,lastSuccessAt:new Date(now).toISOString(),components:['voice','support'],secret:'never-public'}));
  const status=workspaceBackupStatus(file,()=>now);assert.equal(status.healthy,true);assert.equal(status.external,false);assert.equal('secret' in status,false);
  assert.equal(workspaceBackupStatus(file,()=>now+37*3600000).healthy,false);
  fs.writeFileSync(file+'.tmp',JSON.stringify({ok:false,verified:true,lastSuccessAt:new Date(now).toISOString()}));fs.renameSync(file+'.tmp',file);
  assert.equal(workspaceBackupStatus(file,()=>now).healthy,false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
