'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {defaults}=require('./config');
class Store {
  constructor(dir,key){
    if(!/^[a-f0-9]{64}$/i.test(key||''))throw Error('VOICE_ENCRYPTION_KEY должен содержать 64 hex-символа');
    this.key=Buffer.from(key,'hex');fs.mkdirSync(dir,{recursive:true,mode:0o700});this.file=path.join(dir,'state.json');
    this.data=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{config:{...defaults},connections:{},jobs:[],offset:0,quota:{}};
    for(const field of ['botToken','openaiKey','vlessUrl']){const v=this.data.config[field];if(v)this.data.config[field]=this.decrypt(v);}
    this.data.config={...defaults,...this.data.config};
    for(const j of this.data.jobs)if(j.status==='sending') {j.status='uncertain';j.error='Отправка могла завершиться перед перезапуском. Проверьте чат; автоматический повтор отключён.';}
    this.save();
  }
  encrypt(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.key,iv);return {iv:iv.toString('hex'),tag:null,data:Buffer.concat([c.update(text,'utf8'),c.final()]).toString('base64'),...{tag:c.getAuthTag().toString('hex')}};}
  decrypt(v){const d=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.iv,'hex'));d.setAuthTag(Buffer.from(v.tag,'hex'));return Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString('utf8');}
  save(){const data={...this.data,config:{...this.data.config}};for(const f of ['botToken','openaiKey','vlessUrl'])data.config[f]=data.config[f]?this.encrypt(data.config[f]):'';fs.writeFileSync(this.file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
  status(){const {botToken,openaiKey,vlessUrl,...config}=this.data.config;return {config,hasVlessUrl:!!vlessUrl,hasBotToken:!!botToken,hasOpenaiKey:!!openaiKey,connections:Object.values(this.data.connections).map(c=>({id:c.id,ownerId:c.user?.id,enabled:c.is_enabled,canReply:!!c.rights?.can_reply,canDelete:!!c.rights?.can_delete_all_messages})),jobs:this.data.jobs.slice(-30).reverse().map(({id,status,chatId,messageId,seconds,error,created})=>({id,status,chatId,messageId,seconds,error,created})),todaySeconds:this.data.quota[new Date().toISOString().slice(0,10)]||0};}
}
module.exports={Store};
