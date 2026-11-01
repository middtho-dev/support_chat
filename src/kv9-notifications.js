'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function createNotifications(file,clock=()=>Date.now()){
 const read=()=>{try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.schema!==1||!Array.isArray(value.items))throw Error();return value.items;}catch(error){if(error.code==='ENOENT')return [];throw Error('Не удалось прочитать уведомления KV9_');}};
 const write=items=>{fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';try{const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({schema:1,items},null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{try{fs.unlinkSync(tmp);}catch{}}};
 const active=items=>items.filter(n=>!n.cancelledAt&&Date.parse(n.expiresAt)>clock());
 function publish(input,actor){
  if(!input||typeof input.title!=='string'||typeof input.body!=='string'||!Number.isInteger(input.hours)||input.hours<1||input.hours>720||typeof input.requestId!=='string'||!/^[a-f0-9-]{36}$/i.test(input.requestId))throw Error('Укажите заголовок, текст и срок от 1 до 720 часов');
  const title=input.title.trim(),body=input.body.trim();if(!title||title.length>80||!body||body.length>1200||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title+body))throw Error('Заголовок — до 80 символов, текст — до 1200');
  const items=read(),existing=items.find(n=>n.requestId===input.requestId);if(existing){if(existing.title!==title||existing.body!==body||existing.hours!==input.hours)throw Error('Этот запрос уже использован для другого уведомления');return existing;}
  if(active(items).length>=20)throw Error('Уже опубликовано 20 активных уведомлений. Отмените старые.');
  const now=clock(),item={id:crypto.randomUUID(),requestId:input.requestId,title,body,hours:input.hours,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+input.hours*3600000).toISOString(),actor:String(actor||'owner').slice(0,80),cancelledAt:null};
  const next=[item,...items],activeIds=new Set(active(next).map(n=>n.id));let remaining=100-activeIds.size;write(next.filter(n=>activeIds.has(n.id)||remaining-->0));return item;
 }
 function cancel(id,actor){const items=read(),item=items.find(n=>n.id===id);if(!item){const e=Error('Уведомление не найдено');e.status=404;throw e;}if(!item.cancelledAt){item.cancelledAt=new Date(clock()).toISOString();item.cancelledBy=String(actor||'owner').slice(0,80);write(items);}return item;}
 const publicItems=()=>active(read()).map(({id,title,body,createdAt,expiresAt})=>({id,title,body,createdAt,expiresAt})).reverse();
 return {read,publish,cancel,publicItems};
}
module.exports={createNotifications};
