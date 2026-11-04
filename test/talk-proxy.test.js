'use strict';
const{test}=require('node:test'),assert=require('node:assert/strict');const express=require('express');const{createTalkProxy}=require('../src/talk-proxy');
test('Talk management checks owner permission before forwarding; secret is server-side and routes bounded',async()=>{
 const calls=[],app=express();app.use('/talk',createTalkProxy({token:'backend-secret',authorize:t=>({authenticated:!!t,canManageSettings:t==='owner',actor:'operator-7'}),request:async(url,options)=>{calls.push({url:String(url),options});return{status:200,json:async()=>({ok:true})};}}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/talk/state')).status,401);assert.equal((await fetch(base+'/talk/state',{headers:{'x-admin-token':'viewer'}})).status,403);assert.equal(calls.length,0);
  const res=await fetch(base+'/talk/state',{headers:{'x-admin-token':'owner'}});assert.equal(res.status,200);assert.deepEqual(await res.json(),{ok:true});assert.equal(calls[0].options.headers.Authorization,'Bearer backend-secret');assert.equal(calls[0].options.headers['X-Talk-Actor'],'operator-7');
  assert.equal((await fetch(base+'/talk/../../etc/passwd',{headers:{'x-admin-token':'owner'}})).status,404);
  await fetch(base+'/talk/accounts',{method:'POST',headers:{'x-admin-token':'owner','Content-Type':'application/json'},body:JSON.stringify({id:'account',action:'ban'})});assert.equal(JSON.parse(calls[1].options.body).action,'ban');
 }finally{await new Promise(r=>server.close(r));}
});
