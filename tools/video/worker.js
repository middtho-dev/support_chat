'use strict';
const crypto=require('crypto'),fs=require('fs/promises'),path=require('path');
const {extract}=require('./config');
class Worker {
 constructor(store,{call,download,publicUrl}){Object.assign(this,{store,call,download,publicUrl});this.busy=false;this.bot=null;}
 accept(update){
  const m=update.guest_message||update.message,c=this.store.data.config;
  if(!m||!c.enabled)return;
  const guest=!!update.guest_message;
  if(guest&&!m.guest_query_id)return;
  if(!guest&&m.from?.is_bot)return;
  const text=m.text||m.caption||'',name=this.bot?.username;
  if(!guest&&m.chat?.type!=='private'&&!(name&&text.toLowerCase().includes('@'+name.toLowerCase()))&&m.reply_to_message?.from?.id!==this.bot?.id)return;
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
 }
 async tick(){
  if(this.busy||!this.store.data.config.enabled)return;
  const j=this.store.data.jobs.find(j=>j.status==='queued');if(!j)return;
  this.busy=true;const c={...this.store.data.config},dir=path.join(this.store.dir,'files',j.id);
  try{
   j.status='downloading';this.store.save();
   let media;
   if(!j.error)try{media=await this.download(j,c,dir);}catch(e){j.error=e.message;}
   if(!this.store.data.config.enabled){j.status='failed';j.error='Бот выключен до отправки';return;}
   if(media){Object.assign(j,{title:media.title,size:media.size,cap:crypto.randomBytes(32).toString('hex'),expires:Date.now()+c.retentionMinutes*60000});}
   j.status='sending';this.store.save();
   if(j.guest){
    const result=media?{type:'video',id:j.id,video_url:this.publicUrl+'/api/video/files/'+j.id+'/'+j.cap+'.mp4',mime_type:'video/mp4',thumbnail_url:this.publicUrl+'/api/video/files/'+j.id+'/'+j.cap+'.jpg',title:media.title,caption:media.title,video_duration:media.duration}:{type:'article',id:j.id,title:'Видео недоступно',input_message_content:{message_text:j.error}};
    await this.call('answerGuestQuery',{guest_query_id:j.guest,result});
   }else{
    const reply_parameters={message_id:j.message,allow_sending_without_reply:true};
    if(media){const form=new FormData();form.set('chat_id',String(j.chat));form.set('reply_parameters',JSON.stringify(reply_parameters));if(j.thread)form.set('message_thread_id',String(j.thread));form.set('caption',media.title);form.set('supports_streaming','true');form.set('video',new Blob([await fs.readFile(media.file)],{type:'video/mp4'}),'video.mp4');await this.call('sendVideo',form);}
    else await this.call('sendMessage',{chat_id:j.chat,reply_parameters,...(j.thread?{message_thread_id:j.thread}:{}),text:j.error});
   }
   j.status=media?'done':'failed';j.finished=Date.now();
  }catch(e){j.status=j.status==='sending'&&!e.definite?'uncertain':'failed';j.error=e.message||'Ошибка обработки';}
  finally{this.store.save();if(!j.cap)await fs.rm(dir,{recursive:true,force:true});this.busy=false;}
 }
 async cleanup(){
  for(const j of this.store.data.jobs)if(j.expires&&j.expires<Date.now()&&!['downloading','sending'].includes(j.status)){await fs.rm(path.join(this.store.dir,'files',j.id),{recursive:true,force:true});delete j.cap;delete j.expires;}
  this.store.data.jobs=this.store.data.jobs.filter(j=>j.cap||['queued','downloading','sending'].includes(j.status)||j.created>Date.now()-86400000);
  this.store.save();
 }
}
module.exports={Worker};
