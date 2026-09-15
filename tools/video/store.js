'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {defaults}=require('./config');
class Store{
 constructor(dir,key){
  if(!/^[a-f0-9]{64}$/i.test(key||''))throw Error('VIDEO_ENCRYPTION_KEY must be 64 hex characters');
  this.key=Buffer.from(key,'hex');this.dir=dir;fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');
  this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{config:{...defaults},jobs:[]};
  if(this.data.config.botToken){const v=this.data.config.botToken,d=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.iv,'hex'));d.setAuthTag(Buffer.from(v.tag,'hex'));this.data.config.botToken=Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString('utf8');}
  this.data.config={...defaults,...this.data.config};
  for(const j of this.data.jobs){if(j.status==='downloading')j.status='queued';if(j.status==='sending'){j.status='uncertain';j.error='Отправка могла завершиться перед перезапуском; повтор не выполняется.';}}
  this.save();
 }
 save(){
  const config={...this.data.config};if(config.botToken){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.key,iv);config.botToken={iv:iv.toString('hex'),data:Buffer.concat([c.update(config.botToken,'utf8'),c.final()]).toString('base64'),tag:c.getAuthTag().toString('hex')};}
  const fd=fs.openSync(this.file+'.tmp','w',0o600);try{fs.writeFileSync(fd,JSON.stringify({...this.data,config}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(this.file+'.tmp',this.file);
  if(process.platform!=='win32'){const d=fs.openSync(this.dir,'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
 }
}
module.exports={Store};
