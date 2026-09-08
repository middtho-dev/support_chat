'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),path=require('path'),os=require('os');
const {createFrp}=require('../manager');const {groupDevices,primaryProxy}=require('../public/device-links');const {routerScript}=require('../installer');
test('legacy devices can be renamed and deleted; deletion only hides inventory and leaves ports allowed after restart',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'frp-device-'));const state={schemaVersion:1,host:'router.example.org',port:7000,enabled:false,token:'test',dashboardPassword:'test',devices:[{name:'Home_Luci',type:'tcp',port:20080,clientID:'home',online:true},{name:'Home_SSH',type:'tcp',port:20022,clientID:'home',online:true},{name:'Other_Luci',type:'tcp',port:21080,clientID:'other',online:true}],clients:[]};
 fs.writeFileSync(path.join(directory,'state.json'),JSON.stringify(state));let manager=createFrp({directory});
 try{const key=groupDevices((await manager.status()).devices).find(d=>d.name==='Home').key;await manager.action('update-device',{key,name:'Дом',webPort:20080});let s=await manager.status();assert.equal(groupDevices(s.devices).find(d=>d.key===key).name,'Дом');assert.equal(s.devices.find(d=>d.port===20080).web,true);await manager.action('delete-device',{key});s=await manager.status();assert.equal(s.devices.length,1);assert.equal(s.devices[0].port,21080);assert.ok(!s.excludedPorts.includes(20022));assert.ok(!s.excludedPorts.includes(20080));assert.ok(s.allowedRanges.some(r=>r.start<=20080&&r.end>=20080));await manager.shutdown();manager=createFrp({directory});assert.equal((await manager.status()).devices.length,1);await assert.rejects(manager.action('update-device',{key,name:'Restore'}),/не найдено/);}finally{await manager.shutdown();fs.rmSync(directory,{recursive:true,force:true});}
});
test('custom local endpoint is safely quoted and web override works for generic names',()=>{
 const script=routerScript({host:'router.example.org',port:7000,compatibilityMode:true},21080,{localIP:'192.168.1.15',localPort:8080});assert.match(script,/local_ip='192.168.1.15'/);assert.match(script,/local_port='8080'/);assert.match(script,/local_port=\$local_port/);
 const proxy={name:'generic',type:'tcp',port:23025,web:true,online:true};assert.equal(primaryProxy([proxy]),proxy);
});
