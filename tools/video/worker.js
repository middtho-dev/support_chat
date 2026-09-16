'use strict';
const crypto=require('crypto'),fs=require('fs/promises'),path=require('path');
const {extract}=require('./config');
const {Progress}=require('./progress');
class Worker {
 constructor(store,{call,download,publicUrl}){Object.assign(this,{store,call,download,publicUrl});this.busy=false;this.bot=null;this.progress=new Map();}
 accept(update){
  const m=update.guest_message||update.message,c=this.store.data.config;
  if(!m||!c.enabled)return;
  const guest=!!update.guest_message;
  if(guest&&!m.guest_query_id)return;
  if(!guest&&m.from?.is_bot)return;
  const text=m.text||m.caption||'',name=this.bot?.username;
  const command=/^\/video(?:@\w+)?(?:\s|$)/i.test(text);
  if(!guest&&m.chat?.type!=='private'&&!command&&!(name&&text.toLowerCase().includes('@'+name.toLowerCase()))&&m.reply_to_message?.from?.id!==this.bot?.id)return;
  const id=String(update.update_id),jobs=this.store.data.jobs;
  if(jobs.some(j=>j.id===id))return;
  const user=String(m.guest_bot_caller_user?.id||m.guest_bot_caller_chat?.id||m.from?.id||m.sender_chat?.id||'');
  if(!user)return;
  if(!c.allowEveryone&&!c.allowedUsers.split(/[\s,;]+/).includes(user))return;
  // Discard excess calls without generating another potentially abusive reply.
  if(jobs.filter(j=>j.user===user&&j.created>Date.now()-3600000).length>=c.perHour||jobs.filter(j=>['queued','downloading','sending'].includes(j.status)).length>=20)return;
  const link=extract(m);
  jobs.push({id,user,chat:m.chat?.id,message:m.message_id,thread:m.message_thread_id,guest:m.guest_query_id||null,created:Date.now(),status:'queued',...(link||{}),error:!link?'Пришлите ссылку на публичное видео YouTube или Instagram.':!c[link.source]?'Этот источник выключен владельцем бота.':''});
  this.store.save();
  if(this.call)this.announce(jobs[jobs.length-1]);
 }
 announce(j){
  if(this.progress.has(j.id))return this.progress.get(j.id);
  const progress=new Progress(this,j);
  const ready=progress.open().catch(e=>{j.status=e.definite?'failed':'uncertain';j.error=e.message;j.announcing=false;this.progress.delete(j.id);this.store.save();});
  const entry={progress,ready};this.progress.set(j.id,entry);return entry;
 }
 async tick(){
  if(this.busy||!this.store.data.config.enabled)return;
  const j=this.store.data.jobs.find(j=>j.status==='queued');if(!j)return;
  this.busy=true;const c={...this.store.data.config},dir=path.join(this.store.dir,'files',j.id);
  try{
   const entry=this.announce(j);await entry.ready;if(j.status!=='queued')return;
   j.status='downloading';this.store.save();
   entry.progress.update('Проверяем ссылку…');
   let media;
   if(!j.error)try{media=await this.download(j,c,dir,{onProgress:text=>entry.progress.update(text)});}catch(e){j.error=e.message;}
   if(!this.store.data.config.enabled){j.status='failed';j.error='Бот выключен до отправки';return;}
   if(media){Object.assign(j,{title:media.title,size:media.size,cap:crypto.randomBytes(32).toString('hex'),expires:Date.now()+c.retentionMinutes*60000});}
   j.status='sending';this.store.save();
   await entry.progress.finish(media);
   j.status=media?'done':'failed';j.finished=Date.now();
  }catch(e){j.status=j.status==='sending'&&!e.definite?'uncertain':'failed';j.error=e.message||'Ошибка обработки';if(e.definite&&this.progress.has(j.id))try{await this.progress.get(j.id).progress.finish(null);}catch{}}
  finally{await this.progress.get(j.id)?.progress.stop();this.progress.delete(j.id);this.store.save();if(!j.cap)await fs.rm(dir,{recursive:true,force:true});this.busy=false;}
 }
 async cleanup(){
  for(const j of this.store.data.jobs)if(j.expires&&j.expires<Date.now()&&!['downloading','sending'].includes(j.status)){await fs.rm(path.join(this.store.dir,'files',j.id),{recursive:true,force:true});delete j.cap;delete j.expires;}
  this.store.data.jobs=this.store.data.jobs.filter(j=>j.cap||['queued','downloading','sending'].includes(j.status)||j.created>Date.now()-86400000);
  this.store.save();
 }
}
module.exports={Worker};
