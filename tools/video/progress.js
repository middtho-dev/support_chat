'use strict';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const rich=text=>({html:'<p><b>KV9RU · Видео</b></p><p>'+String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')+'</p>'});
// Retry only explicit flood limits, never an ambiguous creation response.
async function limited(call,method,body){
 for(let attempt=0;;attempt++)try{return await call(method,body);}catch(e){
  if(e.code!==429||attempt>=2||!(e.retryAfter>0&&e.retryAfter<=60))throw e;
  await sleep(e.retryAfter*1000);
 }
}
class Progress{
 constructor(worker,job){this.worker=worker;this.job=job;this.pending='';this.closed=false;this.next=0;}
 address(){return this.job.inlineId?{inline_message_id:this.job.inlineId}:{chat_id:this.job.chat,message_id:this.job.outputId};}
 async open(){
  const w=this.worker,j=this.job;
  if(j.inlineId||j.outputId)return;
  j.announcing=true;w.store.save();
  const content=rich(w.busy?'Запрос принят · В очереди на загрузку…':'Запрос принят · Получаем видео…');
  const result=await limited(w.call,j.guest?'answerGuestQuery':'sendRichMessage',j.guest?{
   guest_query_id:j.guest,result:{type:'article',id:j.id,title:'Загрузка видео',input_message_content:{rich_message:content}}
  }:{chat_id:j.chat,...(j.thread?{message_thread_id:j.thread}:{}),rich_message:content});
  if(j.guest){if(!result?.inline_message_id)throw Error('Telegram не вернул идентификатор гостевого ответа');j.inlineId=result.inline_message_id;}
  else{if(!Number.isSafeInteger(result?.message_id))throw Error('Telegram не вернул идентификатор ответа');j.outputId=result.message_id;}
  j.announcing=false;this.next=Date.now()+1200;w.store.save();
  // Guest chat IDs are not ordinary chat IDs. Never use them for deletion.
  if(w.store.data.config.deleteInvocation&&!j.guest&&j.message)try{
   await w.call('deleteMessage',{chat_id:j.chat,message_id:j.message});j.invocationDeleted=true;w.store.save();
  }catch{j.cleanupWarning='Сообщение-вызов не удалено: Telegram не разрешил удаление.';w.store.save();}
 }
 update(text){if(this.closed)return;this.pending=text;this.schedule();}
 schedule(){if(this.timer||this.inflight||!this.pending||this.closed)return;this.timer=setTimeout(()=>{this.timer=null;this.flush();},Math.max(0,this.next-Date.now()));}
 async flush(){
  if(this.closed||!this.pending)return;
  const text=this.pending;this.pending='';
  this.inflight=this.write(text).catch(e=>{this.next=Date.now()+Math.max(1500,(e.retryAfter||0)*1000);});
  await this.inflight;this.inflight=null;this.schedule();
 }
 async write(text){
  if(text===this.last)return;
  this.next=Date.now()+1200;
  try{await this.worker.call('editMessageText',{...this.address(),rich_message:rich(text)});this.last=text;}
  catch(e){if(e.notModified){this.last=text;return;}this.next=Math.max(this.next,Date.now()+(e.retryAfter||0)*1000);throw e;}
 }
 async stop(){this.closed=true;clearTimeout(this.timer);await this.inflight;}
 async finish(media){
  await this.stop();
  const w=this.worker,j=this.job;
  await sleep(Math.max(0,this.next-Date.now()));
  if(!media)return limited(w.call,'editMessageText',{...this.address(),rich_message:rich('Не удалось получить видео\n'+j.error)});
  await sleep(Math.max(0,this.next-Date.now()));
  try{await this.write('Отправляем видео в Telegram…');}catch{}
  const video={type:'video',media:w.publicUrl+'/api/video/files/'+j.id+'/'+j.cap+'.mp4',caption:media.title,duration:media.duration,supports_streaming:true};
  await sleep(Math.max(0,this.next-Date.now()));
  if(j.guest)return limited(w.call,'editMessageMedia',{...this.address(),media:video});
  const fs=require('fs/promises'),form=new FormData();
  form.set('chat_id',String(j.chat));form.set('message_id',String(j.outputId));
  form.set('media',JSON.stringify({...video,media:'attach://video'}));
  form.set('video',new Blob([await fs.readFile(media.file)],{type:'video/mp4'}),'video.mp4');
  return limited(w.call,'editMessageMedia',form);
 }
}
module.exports={Progress,rich,limited};
