'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createEnrollment}=require('../enrollment');
const {createFrp}=require('../manager');
const fs=require('fs'),os=require('os'),path=require('path'),net=require('net');
function fixture(options={}) {
 const state={host:'router.example.org',port:7000,bindAddr:'0.0.0.0',token:'server-frp-secret',devices:[],installerReservations:[],usedPorts:[],...options.state};
 let saves=0; const enrollment=createEnrollment({state,save:()=>saves++,ranges:()=>[{start:20000,end:23000}],refresh:async()=>{},running:()=>true,monitoringError:()=>null,...options,state});
 const issue=()=>{const result=enrollment.issue({name:'Дом',password:'router-test-password',enrollmentUrl:'https://panel.example.org/api/frp/enroll'});const data=JSON.parse(Buffer.from(result.file.match(/FromBase64String\('([^']+)'\)/)[1],'base64').toString());return data.token;};
 return {state,enrollment,issue,saves:()=>saves};
}
test('generation allocates no port; claim checks live/history/reservations and retries occupied sockets',async()=>{
 const checked=[];
 const f=fixture({state:{devices:[{name:'old',port:20000,online:false}],installerReservations:[{port:20001}],usedPorts:[20002]},ranges:()=>[{start:20000,end:20005}],portFree:async p=>{checked.push(p);return p===20005;}});
 const token=f.issue();assert.equal(f.state.enrollments[0].port,null);assert.equal(f.state.installerReservations.length,1);
 const result=await f.enrollment.redeem({token,fingerprint:'b'.repeat(64),operation:'claim'});
 assert.equal(result.port,20005);assert.ok(checked.every(p=>p>=20003));assert.ok(!JSON.stringify(f.state).includes(token));assert.ok(!JSON.stringify(f.state).includes('router-test-password'));
 assert.ok(Buffer.from(result.script,'base64').toString().includes("port='20005'"));
 const again=await f.enrollment.redeem({token,fingerprint:'b'.repeat(64),operation:'claim'});assert.equal(again.port,result.port);
 await assert.rejects(f.enrollment.redeem({token,fingerprint:'c'.repeat(64),operation:'claim'}),/другом роутере/);
 const token2=f.issue();await assert.rejects(f.enrollment.redeem({token:token2,fingerprint:'c'.repeat(64),operation:'claim'}),/Нет свободных/);
});
test('expired, revoked, invalid and unavailable registrations never return config',async()=>{
 const f=fixture();const token=f.issue();
 await assert.rejects(f.enrollment.redeem({token:'d'.repeat(64),fingerprint:'b'.repeat(64),operation:'claim'}));
 f.state.enrollments[0].expiresAt='2020-01-01';await assert.rejects(f.enrollment.redeem({token,fingerprint:'b'.repeat(64),operation:'claim'}),/истёк/);
 const token2=f.issue();f.enrollment.revoke(f.state.enrollments[1].id);await assert.rejects(f.enrollment.redeem({token:token2,fingerprint:'b'.repeat(64),operation:'claim'}),/отозван/);
 for(const options of [{running:()=>false},{monitoringError:()=> 'offline'}]) {const g=fixture(options);await assert.rejects(g.enrollment.redeem({token:g.issue(),fingerprint:'b'.repeat(64),operation:'claim'}));assert.equal(g.state.installerReservations.length,0);}
 assert.throws(()=>f.enrollment.issue({name:'x',password:'x',enrollmentUrl:'http://public.example/api/frp/enroll'}),/HTTPS/);
 assert.throws(()=>f.enrollment.issue({name:'',enrollmentUrl:'https://example.org/api/frp/enroll'}),/Имя/);
});
test('OS listener is excluded, online status verified and revocation preserves assigned ports',async()=>{
 const server=net.createServer();await new Promise(resolve=>server.listen(20000,'0.0.0.0',resolve));
 const f=fixture({ranges:()=>[{start:20000,end:20001}]});
 try{const token=f.issue();const input={token,fingerprint:'b'.repeat(64),operation:'claim'};const result=await f.enrollment.redeem(input);assert.equal(result.port,20001);assert.equal((await f.enrollment.redeem({...input,operation:'status'})).online,false);
 f.state.devices.push({name:'kv9_luci_20001',port:20001,online:true});assert.equal((await f.enrollment.redeem({...input,operation:'status'})).online,true);
 f.enrollment.revoke(f.state.enrollments[0].id);assert.equal(f.state.installerReservations[0].port,20001);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('ticket survives manager restart, secrets are hashed and admin status does not expose capability',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frp-enroll-'));let manager=createFrp({directory});
 try {const result=await manager.action('generate-installer',{name:'Спальня',password:'router-test-password',enrollmentUrl:'https://example.org/api/frp/enroll'});assert.equal(result.status.enrollments,undefined);assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8')).enrollments[0].port,null);await manager.shutdown();manager=createFrp({directory});assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'state.json'),'utf8')).enrollments[0].name,'Спальня');}
 finally{await manager.shutdown();fs.rmSync(directory,{recursive:true,force:true});}
});
