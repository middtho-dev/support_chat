'use strict';
const os=require('node:os'),fs=require('node:fs'),path=require('node:path');
function createServerMetrics({system=os,files=fs,clock=Date.now,diskPath=path.dirname(process.env.DB_PATH||'/app/data/support.db')}={}) {
 const cpu=()=>system.cpus().reduce((sum,c)=>({idle:sum.idle+c.times.idle,total:sum.total+Object.values(c.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
 let previous=cpu(),cached=null;
 return {sample(){
  const now=clock();if(cached&&now-cached.at<1000)return cached;
  const current=cpu(),delta=current.total-previous.total;
  const cpuPercent=delta>0?Math.max(0,Math.min(100,100*(1-(current.idle-previous.idle)/delta))):null;previous=current;
  const totalMemory=system.totalmem();let availableMemory=system.freemem(),disk=null;
  try{const m=files.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)\s+kB/m);if(m)availableMemory=Number(m[1])*1024;}catch(_){}
  try{const stat=files.statfsSync(diskPath);disk={total:stat.blocks*stat.bsize,available:stat.bavail*stat.bsize,used:(stat.blocks-stat.bfree)*stat.bsize};}catch(_){}
  cached={at:now,cpuPercent,totalMemory,usedMemory:Math.max(0,totalMemory-availableMemory),availableMemory,disk,uptime:system.uptime()};return cached;
 }};
}
module.exports={createServerMetrics};
