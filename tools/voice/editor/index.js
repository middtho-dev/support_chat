'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {defaults,validate,eligible,ids}=require('./config');
const {format}=require('./format');
const active=j=>['pending','processing','editing'].includes(j.status);
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const day=()=>new Date().toISOString().slice(0,10);
class Editor{
 constructor(worker){
  this.worker=worker;this.store=worker.store;this.file=path.join(path.dirname(this.store.file),'editor.json');this.busy=false;this.previewing=false;
  this.data=fs.existsSync(this.file)?JSON.parse(this.store.decrypt(JSON.parse(fs.readFileSync(this.file,'utf8')))):{config:{...defaults},jobs:[],quota:{},activatedAt:0,revision:0};
  this.data.config={...defaults,...this.data.config};
  // Never replay edits after restart: the author may have changed the original meanwhile.
  for(const j of this.data.jobs)if(active(j))this.finish(j,'cancelled','Перезапуск; оригинал не обрабатывается повторно');
  this.prune();this.save();
 }
 get enabled(){return this.data.config.enabled;}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.store.encrypt(JSON.stringify(this.data))),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 cancel(j,reason){this.finish(j,j.status==='editing'?'uncertain':'cancelled',j.status==='editing'?'Правка уже передана Telegram. Проверьте сообщение; повтор отключён.':reason);}
 finish(j,status,error=''){j.status=status;j.error=error;j.finished=Date.now();delete j.message;delete j.output;}
 status(){const c=this.store.data.config;return {config:this.data.config,busy:this.busy,ready:!!(c.botToken&&c.openaiKey),transportError:this.worker.error||'',connections:Object.values(this.store.data.connections).map(x=>({id:x.id,ownerId:x.user?.id,name:[x.user?.first_name,x.user?.last_name].filter(Boolean).join(' '),username:x.user?.username,enabled:x.is_enabled,canReply:!!x.rights?.can_reply})),today:this.data.quota[day()]||0,jobs:this.data.jobs.slice(-30).reverse().map(({id,ownerId,chatId,messageId,status,error,created,finished})=>({id,ownerId,chatId,messageId,status,error,created,finished}))};}
 configure(input){
  const config=validate(input,this.data.config),old=this.data.config;
  if(config.enabled&&(!this.store.data.config.botToken||!this.store.data.config.openaiKey))throw Error('Сначала настройте Business-бота и ключ OpenAI в разделе «Голосовые → Подключение»');
  if(config.enabled&&!old.enabled)this.data.activatedAt=Math.floor(Date.now()/1000);
  this.data.config=config;this.data.revision++;
  for(const j of this.data.jobs)if(active(j))this.cancel(j,'Настройки изменены; оригинал сохранён');
  this.save();this.worker.pollController?.abort();return this.status();
 }
 ingest(update){
  const m=update.business_message||update.edited_business_message;
  if(update.deleted_business_messages){const x=update.deleted_business_messages;for(const j of this.data.jobs)if(j.connectionId===x.business_connection_id&&j.chatId===x.chat.id&&x.message_ids.includes(j.messageId)&&active(j))this.cancel(j,'Сообщение удалено');if(this.enabled)for(const messageId of x.message_ids.slice(0,100)){const id=`${x.business_connection_id}:${x.chat.id}:${messageId}`;if(!this.data.jobs.some(j=>j.id===id))this.data.jobs.push({id,connectionId:x.business_connection_id,chatId:x.chat.id,messageId,created:Date.now(),status:'cancelled',error:'Сообщение удалено'});}this.prune();this.save();}
  if(!m)return;
  const id=`${m.business_connection_id}:${m.chat?.id}:${m.message_id}`,existing=this.data.jobs.find(j=>j.id===id);
  if(update.edited_business_message){
   if(!existing&&this.enabled&&ids(this.data.config.ownerIds).includes(String(m.from?.id))){const tombstone={id,connectionId:m.business_connection_id,ownerId:m.from.id,chatId:m.chat?.id,messageId:m.message_id,created:Date.now()};this.finish(tombstone,'cancelled','Сообщение уже изменено автором');this.data.jobs.push(tombstone);this.prune();}
   if(existing&&active(existing)&&hash(m.text||'')!==existing.outputHash)this.cancel(existing,'Автор изменил сообщение; автоматическая правка отменена');
   this.save();return;
  }
  const conn=this.store.data.connections[m.business_connection_id];
  if(existing||!eligible(this.data.config,conn,m)||m.date<this.data.activatedAt||!Number.isFinite(m.date)||Math.abs(Date.now()/1000-m.date)>120)return;
  const used=this.data.quota[day()]||0,full=this.data.jobs.filter(active).length>=100;
  const j={id,connectionId:m.business_connection_id,ownerId:conn.user.id,chatId:m.chat.id,messageId:m.message_id,created:Date.now(),revision:this.data.revision,tokenHash:hash(this.store.data.config.botToken),status:'pending'};
  if(full||used>=this.data.config.dailyLimit)this.finish(j,'skipped',full?'Очередь заполнена':'Дневной лимит исчерпан');
  else{j.message={text:m.text,entities:m.entities||[],date:m.date,from:m.from,chat:{id:m.chat.id,type:'private'},business_connection_id:m.business_connection_id,...(m.link_preview_options?{link_preview_options:m.link_preview_options}:{})};this.data.quota[day()]=used+1;}
  this.data.jobs.push(j);this.prune();this.save();
 }
 valid(j){return !this.worker.stopped&&this.enabled&&active(j)&&j.revision===this.data.revision&&j.tokenHash===hash(this.store.data.config.botToken)&&Date.now()-j.created<300000;}
 async process(j){
  if(!this.valid(j)){this.finish(j,'cancelled','Обработка отменена или сообщение устарело');this.save();return;}
  const m=j.message,c={...this.data.config};this.busy=true;j.status='processing';this.save();
  try{
   const result=await format(this.worker,m.text,m.entities,c);
   if(!this.valid(j))return;
   const conn=await this.worker.telegram('getBusinessConnection',{business_connection_id:j.connectionId});
   if(!this.valid(j))return;
   this.store.data.connections[j.connectionId]=conn;
   if(!eligible(this.data.config,conn,m)){this.finish(j,'cancelled','Аккаунт отключён, исключён или нет права редактировать');return;}
   if(result.text===m.text&&JSON.stringify(result.entities)===JSON.stringify(m.entities)){this.finish(j,'unchanged');return;}
   j.outputHash=hash(result.text);j.status='editing';this.save();
   try{await this.worker.telegram('editMessageText',{business_connection_id:j.connectionId,chat_id:j.chatId,message_id:j.messageId,text:result.text,entities:result.entities,...(m.link_preview_options?{link_preview_options:m.link_preview_options}:{})});}
   catch(e){if(e.notModified){this.finish(j,'unchanged');return;}if(e.code){this.finish(j,'failed','Telegram не разрешил редактирование ('+e.code+'). Проверьте права бота и активность чата.');return;}this.finish(j,'uncertain','Нет подтверждения Telegram. Повтор отключён; проверьте сообщение.');return;}
   if(j.status==='editing')this.finish(j,'done');
  }catch(e){if(active(j))this.finish(j,'failed',String(e.message).slice(0,240));}
  finally{if(active(j))this.finish(j,'cancelled','Обработка отменена; повтор отключён');this.busy=false;this.save();}
 }
 prune(){const cutoff=Date.now()-86400000;this.data.jobs=this.data.jobs.filter(j=>active(j)||j.created>=cutoff).slice(-1000);for(const d of Object.keys(this.data.quota))if(d<day())delete this.data.quota[d];}
 async run(){while(!this.worker.stopped){try{const count=this.data.jobs.length;this.prune();if(this.data.jobs.length!==count)this.save();const j=!this.worker.configuring&&this.enabled&&this.data.jobs.find(x=>x.status==='pending');if(j)await this.process(j);else await new Promise(r=>setTimeout(r,200));}catch{await new Promise(r=>setTimeout(r,1000));}}}
 async api(req,send){
  if(req.method==='GET'&&req.url==='/api/editor')return send(200,this.status());
  if(req.method!=='POST'||!['/api/editor/configure','/api/editor/preview'].includes(req.url))return send(404,{error:'Неизвестный запрос'});
  try{
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>32768)return send(413,{error:'Слишком большой запрос'});}
   const input=JSON.parse(body||'{}');
   if(req.url.endsWith('/configure')){
    if(this.worker.configuring)throw Error('Подключение обновляется; повторите позже');
    // Check the existing webhook without changing or taking over another service.
    if(input.enabled===true&&!this.enabled){const revision=this.data.revision,token=this.store.data.config.botToken;const bot=await this.worker.telegram('getMe',{}),hook=await this.worker.telegram('getWebhookInfo',{});if(!bot.can_connect_to_business)throw Error('Включите Business Mode у бота');if(hook.url&&hook.url!==this.worker.webhookUrl)throw Error('У бота задан webhook другого сервиса');if(revision!==this.data.revision||token!==this.store.data.config.botToken||this.worker.configuring)throw Error('Настройки изменились во время проверки; повторите сохранение');}
    return send(200,this.configure(input));
   }
   if(this.previewing)throw Error('Проверка уже выполняется');
   if(typeof input.text!=='string'||!input.text.trim()||input.text.length>4096)throw Error('Введите текст от 1 до 4096 символов');
   const settings={...input.settings,enabled:false},c=validate(settings,this.data.config);this.previewing=true;
   try{return send(200,await format(this.worker,input.text,[],c));}finally{this.previewing=false;}
  }catch(e){return send(400,{error:String(e.message).slice(0,240)});}
 }
}
module.exports={Editor};
