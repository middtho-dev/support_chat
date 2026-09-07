'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../tools/lampac/bootstrap.js'),'utf8');
test('bootstrap waits for Lampa, retries failure and never starts a second Workspace',()=>{
 const timers=[],scripts=[];const context={setTimeout:fn=>timers.push(fn),document:{createElement:()=>({remove(){}}),head:{appendChild:s=>scripts.push(s)}}};context.window=context;
 vm.runInNewContext(source,context);assert.equal(scripts.length,0);
 context.Lampa={Storage:{},SettingsApi:{}};timers.shift()();assert.equal(scripts.length,1);
 assert.equal(scripts[0].src,'/workspace-client.js?bootstrap=1');
 scripts[0].onerror();timers.shift()();assert.equal(scripts.length,2);
 context.workspaceDeviceControl=true;scripts[1].onload();assert.equal(timers.length,0);
 vm.runInNewContext(source,context);assert.equal(scripts.length,2);
});
test('existing Workspace needs no additional script or storage mutation',()=>{
 const context={workspaceDeviceControl:true};context.window=context;
 vm.runInNewContext(source,context);assert.equal(context.workspaceBootstrap,true);
});
