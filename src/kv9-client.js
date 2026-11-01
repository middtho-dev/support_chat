'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {domainToASCII} = require('node:url');
const {isIP} = require('node:net');
function domain(value) {
  if (typeof value !== 'string' || value.length > 253 || /[\s/:@*?#\\]/.test(value)) throw new Error('Укажите домен без протокола, пути и звёздочек');
  const result = domainToASCII(value.trim().replace(/\.$/, '').toLowerCase());
  if (!result || isIP(result) || result.length > 253 || !result.includes('.') || result.split('.').some(x => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))) throw new Error('Некорректный домен');
  return result;
}
function policy(input) {
  if (!input || typeof input.enabled !== 'boolean' || !Array.isArray(input.domains) || input.domains.length > 100) throw new Error('Укажите переключатель и до 100 доменов');
  const domains = [...new Set(input.domains.map(domain))].sort();
  if (input.enabled && !domains.length) throw new Error('Для включения добавьте хотя бы один домен');
  return {enabled:input.enabled, domains};
}
function createStore(file) {
  function read() {
    try { const data = JSON.parse(fs.readFileSync(file, 'utf8')); policy(data); if(!Number.isSafeInteger(data.revision)||data.revision<1||!Array.isArray(data.history))throw Error(); return data; }
    catch(error) { if(error.code==='ENOENT')return {schema:1,revision:1,enabled:false,domains:['kv9.ru','kv9.org'],updatedAt:null,history:[]}; throw new Error('Не удалось прочитать настройки KV9_'); }
  }
  function write(input, actor) {
    const next=policy(input), old=read();
    if(input.revision!==old.revision) { const error=new Error('Настройки уже изменены. Обновите страницу и повторите.'); error.status=409;throw error; }
    if(old.enabled===next.enabled&&JSON.stringify([...old.domains].sort())===JSON.stringify(next.domains))return old;
    const updatedAt=new Date().toISOString();
    const result={schema:1,revision:old.revision+1,...next,updatedAt,history:[{at:updatedAt,actor:String(actor||'owner').slice(0,80),before:{enabled:old.enabled,domains:old.domains},after:next},...old.history].slice(0,100)};
    fs.mkdirSync(path.dirname(file),{recursive:true}); const temp=file+'.'+process.pid+'.tmp';
    try {const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(result,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);}finally{try{fs.unlinkSync(temp);}catch{}}
    return result;
  }
  return {read,write};
}
function createKv9Client({authorize, file=path.join(path.dirname(process.env.DB_PATH||'/app/data/support.db'),'kv9-client.json'), releases=process.env.KV9_RELEASE_ROOT||'/run/kv9-updates'}) {
  const express=require('express'), admin=express.Router(), store=createStore(file);
  const publicPolicy=(req,res)=>{res.set('Cache-Control','no-store');try{const data=store.read();res.json({schema:1,revision:data.revision,enabled:data.enabled,domains:data.domains,includeSubdomains:true,updatedAt:data.updatedAt});}catch{res.status(503).json({error:'Политика временно недоступна'});}};
  admin.use((req,res,next)=>{const access=authorize(req.get('x-admin-token'));if(!access?.authenticated)return res.status(401).json({error:'Требуется вход'});if(!access.canManageSettings)return res.status(403).json({error:'Нет прав управления'});req.kv9Actor=access.actor||'owner';next();});
  admin.get('/',(req,res)=>{res.set('Cache-Control','no-store');try{let release=null;try{const envelope=JSON.parse(fs.readFileSync(path.join(releases,'channels/stable.json'),'utf8').replace(/^\uFEFF/,''));const catalog=JSON.parse(Buffer.from(envelope.payload,'base64'));release={version:catalog.version,sequence:catalog.sequence,publishedAt:catalog.publishedAt||catalog.publishedUtc,expiresAt:catalog.expiresAt||catalog.expiresUtc,notes:catalog.notes,files:catalog.files?.length,installer:catalog.installer?.url};}catch{}res.json({policy:store.read(),release});}catch(error){res.status(503).json({error:error.message});}});
  admin.put('/policy',express.json({limit:'32kb'}),(req,res)=>{res.set('Cache-Control','no-store');try{res.json({policy:store.write(req.body,req.kv9Actor)});}catch(error){res.status(error.status||400).json({error:error.message});}});
  return {admin,publicPolicy};
}
module.exports={domain,policy,createStore,createKv9Client};
