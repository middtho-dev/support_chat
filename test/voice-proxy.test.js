'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {createVoiceProxy}=require('../src/voice-proxy');
test('voice module rejects missing and non-manager sessions before contacting service',async t=>{
 const app=express();app.use('/voice',createVoiceProxy({authorize:token=>({authenticated:!!token,canManageSettings:false})}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const url='http://127.0.0.1:'+server.address().port+'/voice';
 assert.equal((await fetch(url)).status,401);assert.equal((await fetch(url,{headers:{'x-admin-token':'operator'}})).status,403);
});
