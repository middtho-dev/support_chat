'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createLampacProxy}=require('../src/lampac-proxy');
test('Lampac uses manager authorization, fixed paths and a private service key',async t=>{
  let calls=0;const app=express();app.use(express.json());
  app.use('/lampac',createLampacProxy({authorize:token=>({authenticated:!!token,canManageSettings:token==='manager'}),token:'private-key',fetcher:async(url,options)=>{
    calls++;assert.equal(url.href,'http://127.0.0.1:7600/api/lampac/action');assert.equal(options.headers['x-admin-token'],'private-key');
    assert.deepEqual(JSON.parse(options.body),{action:'restart'});return Response.json({ok:true});
  }}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/lampac';
  assert.equal((await fetch(url)).status,401);
  assert.equal((await fetch(url,{headers:{'x-admin-token':'operator'}})).status,403);
  assert.equal((await fetch(url+'/shell',{headers:{'x-admin-token':'manager'}})).status,404);
  assert.equal(calls,0);
  const response=await fetch(url+'/action',{method:'POST',headers:{'x-admin-token':'manager','Content-Type':'application/json'},body:JSON.stringify({action:'restart'})});
  assert.deepEqual(await response.json(),{ok:true});assert.equal(calls,1);
});
