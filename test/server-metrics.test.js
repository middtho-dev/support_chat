'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createServerMetrics}=require('../src/server-metrics');
test('server metrics use CPU deltas, MemAvailable and the data filesystem',()=>{
 let now=1000,times={idle:500,user:400,sys:100},calls=0,queried;
 const metrics=createServerMetrics({clock:()=>now,diskPath:'/data',system:{
  cpus:()=>[{times}],totalmem:()=>1024*1024,freemem:()=>1,uptime:()=>7200
 },files:{readFileSync:()=>{calls++;return 'MemAvailable: 256 kB\n';},statfsSync:p=>{queried=p;return {blocks:100,bfree:30,bavail:20,bsize:4096};}}});
 times={idle:550,user:425,sys:125};const value=metrics.sample();
 assert.equal(value.cpuPercent,50);assert.equal(value.usedMemory,768*1024);assert.equal(value.availableMemory,256*1024);
 assert.equal(value.disk.available,20*4096);assert.equal(queried,'/data');assert.equal(value.uptime,7200);
 now+=500;assert.equal(metrics.sample(),value);assert.equal(calls,1);
 now+=1000;times={idle:650,user:425,sys:125};assert.equal(metrics.sample().cpuPercent,0);
});
test('failed disk and proc reads stay unavailable and keep the OS memory fallback',()=>{
 const metrics=createServerMetrics({system:{cpus:()=>[{times:{idle:1,user:0}}],totalmem:()=>100,freemem:()=>25,uptime:()=>1},files:{readFileSync:()=>{throw Error('missing');},statfsSync:()=>{throw Error('missing');}}});
 const value=metrics.sample();assert.equal(value.cpuPercent,null);assert.equal(value.disk,null);assert.equal(value.usedMemory,75);
});
