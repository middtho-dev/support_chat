'use strict';
const fs=require('node:fs');
function workspaceBackupStatus(file=process.env.WORKSPACE_BACKUP_STATUS_PATH||'/run/kv9ru/backup-status.json',clock=Date.now){
 try{
  const data=JSON.parse(fs.readFileSync(file,'utf8')),at=Date.parse(data.lastSuccessAt||'');
  const overdue=!Number.isFinite(at)||clock()-at>36*3600000;
  return {configured:true,healthy:data.ok===true&&data.verified===true&&!overdue,verified:data.verified===true,
   overdue,lastSuccessAt:Number.isFinite(at)?new Date(at).toISOString():null,external:data.external===true,
   components:Array.isArray(data.components)?data.components.filter(x=>typeof x==='string').slice(0,30):[],
   files:Number(data.files)||0,bytes:Number(data.bytes)||0,error:data.ok===false?'Резервное копирование не завершено':null};
 }catch{return {configured:false,healthy:false,verified:false,overdue:false,lastSuccessAt:null,external:false,components:[]};}
}
module.exports={workspaceBackupStatus};
