'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'support-dialogs-'));
process.env.DB_PATH=path.join(root,'support.db');process.env.UPLOADS_DIR=path.join(root,'uploads');
process.env.TELEGRAM_BOT_TOKEN='fake-token';process.env.TELEGRAM_ADMIN_IDS='7001';
process.env.TELEGRAM_OPERATOR_LAYOUT='dialog';process.env.TELEGRAM_FILE_DOWNLOAD_ATTEMPTS='1';process.env.PUBLIC_URL='https://support.test';
let next=100,bot,sendFailures=0,deleteFailures=new Set(),customerOnline=false,nativeNetworkFailures=0,nativeValidationFailure=false,mediaRejection=false,mediaTimeout=false,missingEdits=new Set();
const effects=[],emits=[];
class FakeBot {
  constructor(){this.handlers={};bot=this;}
  on(k,v){this.handlers[k]=v;} _request(){return Promise.resolve();}
  startPolling(){return Promise.resolve();} stopPolling(){return Promise.resolve();}
  getWebhookInfo(){return Promise.resolve({url:''});} getMe(){return Promise.resolve({username:'support_fake',has_topics_enabled:false});}
  setMyCommands(){return Promise.resolve();} setChatMenuButton(){return Promise.resolve();}
  getChat(id){return Promise.resolve({id,type:'private',first_name:'Оператор'});}
  async sendMessage(chat,text,options){return this.send('text',chat,text,options);}
  async sendRichMessage(chat,payload,options){
    if(payload.blocks?.some(b=>['photo','video','audio','document'].includes(b.type))){
      if(mediaTimeout){mediaTimeout=false;throw Error('EFATAL: media timeout');}
      if(mediaRejection){mediaRejection=false;const error=Error('Bad Request: cannot fetch media');error.response={body:{error_code:400,description:error.message}};throw error;}
    }
    const sent=this.send('rich',chat,payload.markdown||JSON.stringify(payload.blocks),options);effects.at(-1).rich=payload;return sent;}
  async sendPhoto(chat,file,options){return this.send('photo',chat,String(file),options);}
  async sendVideo(chat,file,options){return this.send('video',chat,String(file),options);}
  async sendAudio(chat,file,options){return this.send('audio',chat,String(file),options);}
  async sendDocument(chat,file,options){return this.send('file',chat,String(file),options);}
  send(kind,chat,text,options){if(sendFailures){sendFailures--;throw Error('EFATAL: unavailable');}const id=++next;effects.push({kind,chat:String(chat),text,options,id});return {message_id:id};}
  async editMessageText(text,options){
    const messageId=text?.message_id||options?.message_id;
    if(missingEdits.has(messageId)){const error=new Error('Bad Request: message to edit not found');error.response={body:{error_code:400,description:'Bad Request: message to edit not found'}};throw error;}
    if(text?.rich_message?.blocks&&nativeNetworkFailures){nativeNetworkFailures--;throw Error('EFATAL: rich network timeout');}
    if(text?.rich_message?.blocks&&nativeValidationFailure){const error=new Error('Unsupported rich block buttons');error.response={body:{error_code:400,description:'Unsupported rich block buttons'}};throw error;}
    effects.push({kind:'edit',text,options});return {};}
  async editMessageReplyMarkup(markup,options){effects.push({kind:'markup',markup,options});return {};}
  async deleteMessage(chat,id){if(deleteFailures.has(Number(id)))throw Error('EFATAL: deletion unavailable');effects.push({kind:'delete',chat:String(chat),id:Number(id)});}
  async deleteForumTopic(chat,id){effects.push({kind:'deleteTopic',chat:String(chat),id});}
  async createForumTopic(){throw Error('NO TOPICS MAY BE CREATED');}
  async closeForumTopic(){throw Error('NO TOPIC CALLS');}
  async editForumTopic(){throw Error('NO TOPIC CALLS');}
  async pinChatMessage(){} async unpinChatMessage(){} async sendChatAction(){} async answerCallbackQuery(id,options){effects.push({kind:'callback',id,options});}
  getFileLink(id){return Promise.resolve('https://fixture-files.test/'+id);}
}
require.cache[require.resolve('node-telegram-bot-api')]={exports:{TelegramBot:FakeBot}};
const db=require('../src/database'),{saveSettings}=require('../src/settings'),telegram=require('../src/telegram-private');
const originalFetch=global.fetch;global.fetch=async url=>String(url).startsWith('https://fixture-files.test/')?new Response(Buffer.from('image'),{headers:{'content-type':'image/jpeg'}}):originalFetch(url);
telegram.init({to:room=>({emit:(event,payload)=>emits.push({room,event,payload})})},{isCustomerInChat:()=>customerOnline});saveSettings({workStartHour:0,workEndHour:24});
const op={id:7001,first_name:'Оператор'};
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.ok(predicate(),'Timed out');};
const state=id=>db.db.prepare('SELECT * FROM telegram_operator_dialogs WHERE ticket_id=? AND operator_id=?').get(id,'7001');
const active=id=>state(id)?.message_id;
async function expireClose(id){db.db.prepare('UPDATE customer_close_requests SET deadline=0 WHERE ticket_id=?').run(id);await telegram.processCustomerCloseRequests();}
const removed=id=>effects.some(e=>e.kind==='delete'&&e.id===id);
const callback=async(data,id,from=op)=>bot.handlers.callback_query({id:'q'+(++next),from,data,message:{message_id:id,chat:{id:from.id,type:'private'}}});
function source(ticket,id,text='Вопрос',type='text',file=null){db.saveMessage.run(id,ticket,'user','Клиент',text,type,file,file?'photo.jpg':null,file?'image/jpeg':null,null,null);return db.getMessageById.get(id);}
async function reply(id,text,messageId,extra={}){await bot.handlers.message({message_id:messageId,chat:{id:7001,type:'private'},from:op,...(text?{text}:{}),reply_to_message:{message_id:id},...extra});}
function fresh(id){db.createTicket.run(id,'Клиент '+id,'session-'+id);return db.getTicketById.get(id);}
const owned=id=>db.db.prepare("SELECT * FROM telegram_operator_dialog_messages WHERE ticket_id=? AND kind='card' AND cleanup=0").all(id);

test.after(async()=>{await telegram.shutdown();global.fetch=originalFetch;if(db.db.open)db.db.close();fs.rmSync(root,{recursive:true,force:true});});

test('default dialog works without Threaded Mode and creates no topics or pin notices',async()=>{
  await wait(()=>telegram.status().connected);await bot.handlers.message({message_id:1,chat:{id:7001,type:'private'},from:op,text:'/start'});
  const ticket=fresh('dialog-one');const id=await telegram.createTopic(ticket.id);assert.ok(id);assert.equal(db.getTicketById.get(ticket.id).assigned_operator_id,'7001');
  assert.equal(telegram.status().operatorLayout,'dialog');assert.equal(telegram.status().threadedModeEnabled,false);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM telegram_ticket_threads').get().n,0);
  assert.equal(owned(ticket.id).length,1);assert.equal(effects.find(e=>e.id===id&&e.kind==='rich').options.message_thread_id,undefined);
});

test('start menu native buttons navigate and return on the same panel, with an accurate unanswered filter',async()=>{
  const panel=db.getTelegramOperatorDashboard.get('7001'),initial=effects.find(e=>e.id===panel.dashboard_message_id&&e.kind==='rich');
  assert.ok(initial.rich.blocks.some(b=>b.type==='buttons'));assert.equal(initial.options.reply_markup.inline_keyboard.length,0);
  const make=(id,name,assigned,last)=>{db.createTicket.run(id,name,'session-'+id);if(assigned)db.assignTicketIfUnassigned.run(assigned,id);if(last)db.saveMessage.run(id+'-msg',id,last,name,'Тест','text',null,null,null,null,null);};
  make('menu-new','Новое меню',null,'user');make('menu-pending','Ожидает в меню','7001','user');make('menu-answered','Ответили в меню','7001','support');
  const count=effects.filter(e=>e.kind==='rich').length;
  await callback('dashboard:refresh',panel.dashboard_message_id);
  const native=effects.findLast(e=>e.kind==='edit'&&e.text?.rich_message?.blocks).text.rich_message;
  const controls=native.blocks.filter(b=>b.type==='buttons').flatMap(b=>b.buttons);
  assert.ok(controls.some(b=>b.callback_data==='list:unanswered:0'&&b.text.endsWith('· 1')));
  await callback('list:unanswered:0',panel.dashboard_message_id);
  const list=effects.findLast(e=>e.kind==='edit').text;assert.match(JSON.stringify(list.rich_message.blocks),/Ожидает в меню/);assert.doesNotMatch(JSON.stringify(list.rich_message.blocks),/Ответили в меню/);
  for(const action of ['dashboard:show','list:waiting:0','dashboard:show','list:mine:0','dashboard:show','list:closed:0','dashboard:show','system:show','dashboard:show'])await callback(action,panel.dashboard_message_id);
  assert.equal(effects.filter(e=>e.kind==='rich').length,count,'Navigation edits the saved panel rather than sending another');
  assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,panel.dashboard_message_id);
  await callback('list:waiting:0',panel.dashboard_message_id);await callback('claim:menu-new:0',panel.dashboard_message_id);
  assert.equal(db.getTicketById.get('menu-new').assigned_operator_id,'7001');await wait(()=>active('menu-new'));
  await callback('close:menu-new',active('menu-new'));await expireClose('menu-new');
  for(const id of ['menu-pending','menu-answered'])db.closeTicket.run(id);
  await callback('dashboard:show',panel.dashboard_message_id);
});

test('new user message replaces the same Rich dialog with a notification, not a second inbox',async()=>{
  const old=active('dialog-one'),message=source('dialog-one','first-question','Здравствуйте');
  await telegram.forwardMessage(db.getTicketById.get('dialog-one'),message);
  const card=active('dialog-one');assert.notEqual(card,old);assert.ok(removed(old));assert.equal(owned('dialog-one').length,1);
  const sent=effects.find(e=>e.kind==='rich'&&e.id===card);assert.equal(sent.options.disable_notification,false);
  assert.ok(sent.rich.blocks.filter(b=>b.type==='buttons').flatMap(b=>b.buttons).some(b=>b.callback_data==='replyticket:dialog-one'));assert.deepEqual(sent.options.reply_markup.inline_keyboard,[]);
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM telegram_support_inbox').get().n,0);
});

test('bursts coalesce on one card and notification work is persisted',async()=>{
  const old=active('dialog-one');await telegram.forwardMessage(db.getTicketById.get('dialog-one'),source('dialog-one','second-question','Дополнение'));
  assert.equal(active('dialog-one'),old);assert.equal(owned('dialog-one').length,1);assert.equal(state('dialog-one').dirty,1);
  db.db.prepare('UPDATE telegram_operator_dialogs SET last_alert_at=0,next_retry_at=0 WHERE ticket_id=?').run('dialog-one');
  await telegram.processDeliveryQueue();assert.notEqual(active('dialog-one'),old);assert.ok(removed(old));assert.equal(owned('dialog-one').length,1);
});

test('button uses one temporary Reply prompt; answer is plain and card remains after receipt',async()=>{
  await callback('replyticket:dialog-one',active('dialog-one'));const prompt=effects.findLast(e=>e.options?.reply_markup?.force_reply);
  await callback('replyticket:dialog-one',active('dialog-one'));const newer=effects.findLast(e=>e.options?.reply_markup?.force_reply);assert.ok(removed(prompt.id));
  await reply(newer.id,'Ответ без цитирования',501);
  const message=db.getMessageByTelegramDestination.get('7001',501);assert.ok(message);assert.equal(message.ticket_id,'dialog-one');assert.equal(message.reply_to_id,null);
  await wait(()=>removed(501));assert.equal(db.getMessageById.get(message.id).web_delivered_at,null);const card=active('dialog-one');
  telegram.confirmWebCustomerDelivery('dialog-one',message.id);await telegram.processDeliveryQueue();
  await wait(()=>removed(501));assert.ok(removed(newer.id));assert.equal(removed(card),false);assert.equal(owned('dialog-one').length,1);
});

test('late receipt updates the card without removing the next prompt or the canonical dialog',async()=>{
  const message=db.getMessageByTelegramDestination.get('7001',501);
  await callback('replyticket:dialog-one',active('dialog-one'));const prompt=effects.findLast(e=>e.options?.reply_markup?.force_reply);
  const card=active('dialog-one');telegram.confirmWebCustomerDelivery('dialog-one',message.id);await telegram.processDeliveryQueue();
  assert.equal(removed(prompt.id),false);assert.equal(removed(card),false);
});

test('Rich header counts every pending reply and refreshes presence/delivery quietly',async()=>{
  await reply(active('dialog-one'),'Первый ожидающий ответ',511);
  await reply(active('dialog-one'),'Второй ожидающий ответ',512);
  const first=db.getMessageByTelegramDestination.get('7001',511),second=db.getMessageByTelegramDestination.get('7001',512);
  const text=()=>{const item=effects.findLast(e=>e.kind==='edit'&&(e.options?.message_id||e.text?.message_id)===active('dialog-one'));return JSON.stringify(item?.text?.rich_message?.blocks||item?.text||'');};
  await telegram.refreshTicketDialog('dialog-one');assert.match(text(),/🔴 Клиент не в чате/);assert.match(text(),/Ещё не получено клиентом: 2/);
  const statusBlocks=effects.findLast(e=>e.kind==='edit'&&e.text?.message_id===active('dialog-one')).text.rich_message.blocks;
  assert.equal(statusBlocks[0].text.text,'🔴 Клиент не в чате');assert.match(statusBlocks[1].text,/Ещё не получено клиентом: 2/);assert.match(statusBlocks[2].text,/Ответы сохранены/);
  assert.equal(first.web_delivered_at,null);assert.equal(second.web_delivered_at,null);await wait(()=>removed(511)&&removed(512));
  const sends=effects.filter(e=>e.kind==='rich').length;customerOnline=true;
  telegram.confirmWebCustomerDelivery('dialog-one',first.id);await telegram.refreshTicketDialog('dialog-one');
  assert.match(text(),/🟢 Клиент в чате/);assert.match(text(),/Ещё не получено клиентом: 1/);
  telegram.confirmWebCustomerDelivery('dialog-one',second.id);await telegram.refreshTicketDialog('dialog-one');assert.match(text(),/Все ответы получены клиентом/);
  assert.equal(effects.filter(e=>e.kind==='rich').length,sends,'Presence/receipts edit silently, without new cards');customerOnline=false;
});

test('direct Reply to card supports photos, documents and album continuation without quotes',async()=>{
  await reply(active('dialog-one'),null,502,{photo:[{file_id:'first',file_size:5}],media_group_id:'photos'});
  const first=db.getMessageByTelegramDestination.get('7001',502);assert.equal(first.message_type,'image');assert.equal(first.reply_to_id,null);
  await wait(()=>removed(502));assert.equal(db.getMessageById.get(first.id).web_delivered_at,null);
  telegram.confirmWebCustomerDelivery('dialog-one',first.id);await telegram.processDeliveryQueue();
  await bot.handlers.message({message_id:503,chat:{id:7001,type:'private'},from:op,photo:[{file_id:'second',file_size:5}],media_group_id:'photos'});
  const second=db.getMessageByTelegramDestination.get('7001',503);assert.equal(second.ticket_id,'dialog-one');
  telegram.confirmWebCustomerDelivery('dialog-one',second.id);await telegram.processDeliveryQueue();
  await reply(active('dialog-one'),'Документ',504,{document:{file_id:'doc',file_name:'note.txt',mime_type:'text/plain',file_size:5}});
  assert.equal(db.getMessageByTelegramDestination.get('7001',504).message_type,'file');
});

test('incoming attachment stays in Rich history and opens only on demand',async()=>{
  fs.mkdirSync(process.env.UPLOADS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.UPLOADS_DIR,'client.jpg'),'photo');
  const before=effects.filter(e=>e.kind==='photo'&&e.chat==='7001').length;
  await telegram.forwardMessage(db.getTicketById.get('dialog-one'),source('dialog-one','client-image','Скриншот','image','/uploads/client.jpg'));
  assert.equal(effects.filter(e=>e.kind==='photo'&&e.chat==='7001').length,before);
  await callback('dialogfiles:dialog-one',active('dialog-one'));
  const files=effects.findLast(e=>e.kind==='edit').text.rich_message.blocks;
  assert.ok(files.filter(b=>b.type==='buttons').flatMap(b=>b.buttons).some(b=>b.callback_data==='dialogfile:client-image'));
  await telegram.refreshTicketDialog('dialog-one');assert.equal(state('dialog-one').view,'files:0');
  assert.match(JSON.stringify(effects.findLast(e=>e.kind==='edit').text.rich_message.blocks),/Вложения/);
  await callback('dialogfile:client-image',active('dialog-one'));const preview=effects.findLast(e=>e.kind==='rich'&&e.rich?.blocks?.some(b=>b.type==='photo'));assert.ok(preview);
  assert.equal(preview.rich.blocks.find(b=>b.type==='photo').photo.media,'https://support.test/uploads/client.jpg');
  await callback('dialogreply:client-image',preview.id);const prompt=effects.findLast(e=>e.options?.reply_markup?.force_reply);
  const target=db.db.prepare("SELECT source_message_id FROM telegram_operator_dialog_messages WHERE message_id=? AND kind='prompt'").get(prompt.id);assert.equal(target.source_message_id,'client-image');
  await callback('dialoghide:dialog-one',preview.id);assert.ok(removed(preview.id));assert.equal(owned('dialog-one').length,1);
  await callback('ticketmain:dialog-one',active('dialog-one'));assert.equal(state('dialog-one').view,'dialog');
});

test('Rich media rejection preserves buttons globally; an ambiguous timeout never resends the file',async()=>{
 const card=active('dialog-one');mediaRejection=true;
 await callback('dialogfile:client-image',card);
 const fallback=effects.findLast(e=>e.kind==='photo');assert.ok(fallback);
 assert.ok(fallback.options.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='dialogreply:client-image'));
 assert.equal(telegram.status().richBlocksAvailable,true);
 const count=effects.filter(e=>['photo','file'].includes(e.kind)).length;
 mediaTimeout=true;await callback('dialogfile:client-image',card);
 assert.equal(effects.filter(e=>['photo','file'].includes(e.kind)).length,count);
 assert.equal(telegram.status().richBlocksAvailable,true);
});

test('customer Rich proposal offers close and continue, repeat clicks keep the deadline and Continue cancels it',async()=>{
 const customer='8101',id='customer-countdown';
 db.createTelegramTicket.run(id,'Клиент таймера','session-'+id,customer,customer,null,null,null,null);
 source(id,'customer-countdown-q','Вопрос');await telegram.createTopic(id);const card=active(id);
 await callback('close:'+id,card);assert.equal(db.getTicketById.get(id).status,'open');
 const request=db.db.prepare('SELECT * FROM customer_close_requests WHERE ticket_id=?').get(id);
 assert.equal(request.state,'pending');assert.ok(request.deadline-Date.now()>295000);
 const control=db.getTicketById.get(id).telegram_customer_control_message_id;
 const proposal=effects.find(e=>e.kind==='rich'&&e.id===control);
 const controls=proposal.rich.blocks.filter(b=>b.type==='buttons').flatMap(b=>b.buttons);
 assert.ok(controls.some(b=>b.callback_data==='customer:close'));assert.ok(controls.some(b=>b.callback_data==='customer:continue:'+id));
 assert.match(JSON.stringify(proposal.rich.blocks),/через 5 минут/);assert.deepEqual(proposal.options.reply_markup.inline_keyboard,[]);
 const count=db.getMessages.all(id).filter(m=>m.message_type==='close_prompt').length;
 await callback('close:'+id,card);assert.equal(db.db.prepare('SELECT deadline FROM customer_close_requests WHERE ticket_id=?').get(id).deadline,request.deadline);
 assert.equal(db.getMessages.all(id).filter(m=>m.message_type==='close_prompt').length,count);
 await callback('customer:continue:'+id,control,{id:8102,first_name:'Другой клиент'});
 assert.equal(db.db.prepare('SELECT state FROM customer_close_requests WHERE ticket_id=?').get(id).state,'pending');
 await callback('customer:continue:'+id,control,{id:8101,first_name:'Клиент'});
 assert.equal(db.db.prepare('SELECT state FROM customer_close_requests WHERE ticket_id=?').get(id).state,'cancelled');
 await expireClose(id);assert.equal(db.getTicketById.get(id).status,'open');
 await callback('close:'+id,active(id));
 await bot.handlers.message({message_id:8701,from:{id:8101,first_name:'Клиент'},chat:{id:8101,type:'private'},text:'Ещё нужна помощь'});
 assert.equal(db.db.prepare('SELECT state FROM customer_close_requests WHERE ticket_id=?').get(id).state,'cancelled');
 await expireClose(id);assert.equal(db.getTicketById.get(id).status,'open');
 await callback('close:'+id,active(id));await callback('customer:close',db.getTicketById.get(id).telegram_customer_control_message_id,{id:8101,first_name:'Клиент'});
 assert.equal(db.getTicketById.get(id).status,'closed');assert.equal(active(id),null);
});

test('unanswered reminder recreates the card with sound and no separate reminder message',async()=>{
  const old=active('dialog-one');db.db.prepare("UPDATE messages SET created_at=datetime('now','-10 minutes') WHERE id='client-image'").run();
  // Make the live last message unambiguously the client's pending question.
  source('dialog-one','reminder-source','Жду ответа');db.db.prepare("UPDATE messages SET created_at=datetime('now','-5 minutes') WHERE id='reminder-source'").run();
  db.db.prepare("UPDATE messages SET created_at=datetime('now','-20 minutes') WHERE ticket_id='dialog-one' AND id NOT IN ('reminder-source')").run();
  const count=effects.filter(e=>e.kind==='text'&&e.chat==='7001').length;
  const sent=await telegram.processUnansweredReminders();assert.equal(sent,1);assert.notEqual(active('dialog-one'),old);assert.ok(removed(old));
  assert.equal(effects.filter(e=>e.kind==='text'&&e.chat==='7001').length,count);assert.equal(owned('dialog-one').length,1);
});

test('transient send failure persists and recovers without a duplicate active card',async()=>{
  fresh('retry-dialog');const message=source('retry-dialog','retry-source');sendFailures=1;
  await assert.rejects(()=>telegram.forwardMessage(db.getTicketById.get('retry-dialog'),message),/unavailable/);
  assert.equal(state('retry-dialog').dirty,1);db.db.prepare("UPDATE telegram_operator_dialogs SET next_retry_at=0 WHERE ticket_id='retry-dialog'").run();
  await telegram.processDeliveryQueue();assert.ok(active('retry-dialog'));assert.equal(owned('retry-dialog').length,1);
});

test('close removes card, unanswered previews, prompts and undelivered responses with durable retry',async()=>{
  await callback('replyticket:dialog-one',active('dialog-one'));const prompt=effects.findLast(e=>e.options?.reply_markup?.force_reply);
  await reply(prompt.id,'Ответ перед закрытием',505);const card=active('dialog-one');deleteFailures.add(card);
  await callback('close:dialog-one',card);
  assert.equal(db.getTicketById.get('dialog-one').status,'open');assert.equal(active('dialog-one'),card);
  const proposal=db.getMessages.all('dialog-one').find(m=>m.message_type==='close_prompt');assert.match(proposal.content,/через 5 минут/);
  await expireClose('dialog-one');assert.equal(db.getTicketById.get('dialog-one').status,'closed');assert.equal(active('dialog-one'),null);
  assert.ok(removed(prompt.id));assert.ok(removed(505));assert.equal(removed(card),false);
  assert.ok(telegram.status().dialogs.cleanupPending>0);deleteFailures.delete(card);
  db.db.prepare('UPDATE telegram_operator_dialog_messages SET next_retry_at=0 WHERE message_id=?').run(card);
  await telegram.processDeliveryQueue();await wait(()=>removed(card));assert.equal(owned('dialog-one').length,0);
  assert.ok(db.getMessages.all('dialog-one').length>0,'Workspace history survives cleanup');
});

test('legacy topics and duplicate notifications migrate into a single card',async()=>{
  const ticket=fresh('legacy-migration');db.assignTicketIfUnassigned.run('7001',ticket.id);
  db.saveTelegramThread.run(ticket.id,'7001','7001',900,901);db.saveTelegramNotification.run(ticket.id,'7001','7001',902,'open');
  await telegram.forwardMessage(db.getTicketById.get(ticket.id),source(ticket.id,'legacy-source'));
  for(let i=0;i<200&&!effects.some(e=>e.kind==='deleteTopic'&&e.id===900);i++){await telegram.processDeliveryQueue();await new Promise(r=>setTimeout(r,20));}
  assert.ok(effects.some(e=>e.kind==='deleteTopic'&&e.id===900));
  assert.ok(removed(901));assert.ok(removed(902));assert.equal(owned(ticket.id).length,1);assert.equal(db.getTelegramThreadForTicket.get(ticket.id),undefined);
});

test('web/customer close and inactivity close clean the complete operator dialog too',async()=>{
  for(const [id,method] of [['external-close','notifyTicketClosed'],['system-close','autoCloseTicket']]) {
    const ticket=fresh(id);await telegram.forwardMessage(ticket,source(id,id+'-source'));
    const card=active(id);assert.ok(card);await callback('replyticket:'+id,card);
    const prompt=effects.findLast(e=>e.options?.reply_markup?.force_reply);
    db.closeTicket.run(id);await telegram[method](db.getTicketById.get(id));
    assert.ok(removed(card));assert.ok(removed(prompt.id));assert.equal(active(id),null);
  }
});

test('multiple operators share unassigned cards but only the atomic assignee can reply',async()=>{
  db.saveManagedTelegramOperator.run('7002','Второй оператор',null,1,0);
  try {
    const ticket=fresh('two-operators');await telegram.forwardMessage(ticket,source(ticket.id,'two-source'));
    const rows=db.db.prepare('SELECT * FROM telegram_operator_dialogs WHERE ticket_id=? AND message_id IS NOT NULL').all(ticket.id);
    assert.equal(rows.length,2);const own=rows.find(r=>r.operator_id==='7001'),other=rows.find(r=>r.operator_id==='7002');
    await callback('replyticket:'+ticket.id,own.message_id);
    await wait(()=>db.getTicketById.get(ticket.id).assigned_operator_id==='7001');
    await bot.handlers.message({message_id:508,chat:{id:7002,type:'private'},from:{id:7002,first_name:'Другой оператор'},text:'Чужой ответ',reply_to_message:{message_id:other.message_id}});
    assert.equal(db.getMessageByTelegramDestination.get('7002',508),undefined);
    await wait(()=>db.db.prepare('SELECT message_id FROM telegram_operator_dialogs WHERE ticket_id=? AND operator_id=?').get(ticket.id,'7002').message_id===null);
    await callback('close:'+ticket.id,active(ticket.id));await expireClose(ticket.id);assert.equal(active(ticket.id),null);
  }finally{db.deactivateTelegramOperator.run('7002');}
});

test('closed and reassigned card replies never reach a different customer',async()=>{
  const id=active('retry-dialog'),before=db.getMessages.all('retry-dialog').length;
  db.db.prepare("UPDATE tickets SET assigned_operator_id='7002' WHERE id='retry-dialog'").run();await reply(id,'Чужой клиент',506);
  assert.equal(db.getMessages.all('retry-dialog').length,before);
  db.db.prepare("UPDATE tickets SET status='closed' WHERE id='retry-dialog'").run();await reply(id,'Закрытый клиент',507);
  assert.equal(db.getMessages.all('retry-dialog').length,before);
});

test('automatic refresh preserves active list, native controls and panel ID; clear confirmation pauses it',async()=>{
 const panel=db.getTelegramOperatorDashboard.get('7001'),id=panel.dashboard_message_id;
 const created=effects.filter(e=>e.kind==='rich').length;
 await callback('list:waiting:0',id);
 fresh('live-list-ticket');source('live-list-ticket','live-list-question','Новый вопрос в открытом списке');
 db.db.prepare('UPDATE telegram_operator_panel_views SET next_refresh=0 WHERE operator_id=?').run('7001');
 await telegram.refreshOperatorPanels();
 const list=effects.findLast(e=>e.kind==='edit'&&e.text?.message_id===id).text.rich_message.blocks;
 assert.match(JSON.stringify(list),/Новый вопрос в открытом списке/);
 assert.ok(list.filter(b=>b.type==='buttons').flatMap(b=>b.buttons).some(b=>b.callback_data==='claim:live-list-ticket:0'));
 assert.equal(db.db.prepare('SELECT view FROM telegram_operator_panel_views WHERE operator_id=?').get('7001').view,'list:waiting');
 const edits=effects.filter(e=>e.kind==='edit').length;
 db.db.prepare('UPDATE telegram_operator_panel_views SET next_refresh=0 WHERE operator_id=?').run('7001');
 await telegram.refreshOperatorPanels();assert.equal(effects.filter(e=>e.kind==='edit').length,edits,'unchanged list is not edited');
 await callback('system:show',id);
 const system=effects.findLast(e=>e.kind==='edit').text.rich_message.blocks;
 for(const label of ['CPU','Память','Диск','Без перезагрузки','Очередь'])assert.match(JSON.stringify(system),new RegExp(label));
 assert.ok(!system.filter(b=>b.type==='buttons').flatMap(b=>b.buttons).some(b=>b.callback_data?.includes('refresh')));
 await callback('dashboard:clear',id);const confirm=effects.filter(e=>e.kind==='edit').length;
 db.db.prepare('UPDATE telegram_operator_panel_views SET next_refresh=0 WHERE operator_id=?').run('7001');
 await telegram.refreshOperatorPanels();assert.equal(effects.filter(e=>e.kind==='edit').length,confirm);
 await callback('system:show',id);assert.equal(db.db.prepare('SELECT pause_until FROM telegram_operator_panel_views WHERE operator_id=?').get('7001').pause_until,0);
 assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,id);
 assert.equal(effects.filter(e=>e.kind==='rich').length,created);
 db.closeTicket.run('live-list-ticket');await callback('dashboard:show',id);
});

test('shared mode lets both operators answer assigned and unassigned tickets; switching off restores ownership',async()=>{
 const second={id:7002,first_name:'Второй оператор'};
 db.saveManagedTelegramOperator.run('7002','Второй оператор',null,1,0);
 const getCard=(id,op)=>db.db.prepare('SELECT message_id FROM telegram_operator_dialogs WHERE ticket_id=? AND operator_id=?').get(id,String(op))?.message_id;
 const secondReply=(target,text,id,extra={})=>bot.handlers.message({message_id:id,chat:{id:7002,type:'private'},from:second,text,reply_to_message:{message_id:target},...extra});
 try{
  const ticket=fresh('shared-existing');db.assignTicketIfUnassigned.run('7001',ticket.id);
  await telegram.forwardMessage(db.getTicketById.get(ticket.id),source(ticket.id,'shared-question','Общий вопрос'));
  assert.equal(getCard(ticket.id,'7002'),undefined);
  saveSettings({telegramSharedTickets:true});await telegram.reconcileOperatorAccess();
  assert.ok(getCard(ticket.id,'7002'));assert.ok(getCard(ticket.id,'7001'));
  assert.equal(db.getTicketById.get(ticket.id).assigned_operator_id,'7001','existing assignment is preserved');
  const native=effects.findLast(e=>e.kind==='rich'&&e.id===getCard(ticket.id,'7002')).rich;
  assert.ok(!native.blocks.filter(b=>b.type==='buttons').flatMap(b=>b.buttons).some(b=>b.callback_data==='take:'+ticket.id));
  await callback('replyticket:'+ticket.id,getCard(ticket.id,'7002'),second);
  const prompt=effects.findLast(e=>e.chat==='7002'&&e.options?.reply_markup?.force_reply);
  assert.ok(prompt);await secondReply(prompt.id,'Ответ второго оператора',9201);
  await reply(getCard(ticket.id,'7001'),'Ответ первого оператора',9202);
  assert.equal(db.getMessageByTelegramDestination.get('7002',9201).ticket_id,ticket.id);
  assert.equal(db.getMessageByTelegramDestination.get('7001',9202).ticket_id,ticket.id);
  assert.notEqual(db.getMessageByTelegramDestination.get('7002',9201).sender_name,db.getMessageByTelegramDestination.get('7001',9202).sender_name);
  await secondReply(getCard(ticket.id,'7002'),null,9203,{photo:[{file_id:'shared-file',file_size:5}]});
  assert.equal(db.getMessageByTelegramDestination.get('7002',9203).message_type,'image');
  await telegram.refreshTicketDialog(ticket.id);
  for(const op of ['7001','7002'])assert.match(JSON.stringify(effects.findLast(e=>e.kind==='edit'&&e.text?.message_id===getCard(ticket.id,op)).text.rich_message),/Ответ первого оператора/);
  await callback('dialogfiles:'+ticket.id,getCard(ticket.id,'7002'),second);
  assert.match(JSON.stringify(effects.findLast(e=>e.kind==='edit').text.rich_message),/Вложения/);
  const unassigned=fresh('shared-unassigned');await telegram.forwardMessage(unassigned,source(unassigned.id,'shared-unassigned-question'));
  await secondReply(getCard(unassigned.id,'7002'),'Ответ без назначения',9204);
  assert.equal(db.getMessageByTelegramDestination.get('7002',9204).ticket_id,unassigned.id);
  assert.equal(db.getTicketById.get(unassigned.id).assigned_operator_id,null);
  const retry=fresh('shared-retry');const retryMessage=source(retry.id,'shared-retry-question');sendFailures=1;
  await assert.rejects(()=>telegram.forwardMessage(retry,retryMessage),/unavailable/);
  db.db.prepare('UPDATE telegram_operator_dialogs SET next_retry_at=0 WHERE ticket_id=?').run(retry.id);
  db.db.prepare('UPDATE messages SET telegram_next_retry_at=NULL WHERE id=?').run(retryMessage.id);
  assert.ok(db.getPendingPrivateTelegramMessages.all(100).some(m=>m.id===retryMessage.id));
  await telegram.processDeliveryQueue();assert.ok(db.getMessageById.get(retryMessage.id).telegram_message_id);
  assert.ok(getCard(retry.id,'7001'));assert.ok(getCard(retry.id,'7002'));assert.equal(db.getTicketById.get(retry.id).assigned_operator_id,null);
  db.closeTicket.run(retry.id);await telegram.notifyTicketClosed(db.getTicketById.get(retry.id));
  source(ticket.id,'shared-reminder-question','Вопрос всей команде');
  db.db.prepare("UPDATE messages SET created_at=datetime('now','-20 minutes') WHERE ticket_id=?").run(ticket.id);
  db.db.prepare("UPDATE messages SET created_at=datetime('now','-5 minutes') WHERE id='shared-reminder-question'").run();
  const beforeReminder=['7001','7002'].map(op=>getCard(ticket.id,op));await telegram.processUnansweredReminders();
  for(const [i,op] of ['7001','7002'].entries())assert.notEqual(getCard(ticket.id,op),beforeReminder[i]);
  const oldOther=getCard(ticket.id,'7002'),oldOwner=getCard(ticket.id,'7001');
  const previousFetch=global.fetch;let releaseDownload,downloadStarted;
  const started=new Promise(resolve=>{downloadStarted=resolve;});
  global.fetch=async url=>{if(String(url).endsWith('/shared-delayed')){downloadStarted();await new Promise(resolve=>{releaseDownload=resolve;});return new Response(Buffer.from('photo'),{headers:{'content-type':'image/jpeg'}});}return previousFetch(url);};
  const inFlight=secondReply(oldOther,null,9206,{photo:[{file_id:'shared-delayed',file_size:5}]});
  await started;
  try{saveSettings({telegramSharedTickets:false});await telegram.reconcileOperatorAccess();}
  finally{releaseDownload();global.fetch=previousFetch;}
  await inFlight;assert.equal(db.getMessageByTelegramDestination.get('7002',9206),undefined,'access is rechecked after downloading a file');
  assert.equal(getCard(ticket.id,'7002'),null);assert.ok(removed(oldOther));assert.equal(getCard(ticket.id,'7001'),oldOwner);
  await secondReply(oldOther,'Запрещённый ответ',9205);assert.equal(db.getMessageByTelegramDestination.get('7002',9205),undefined);
  await callback('close:'+ticket.id,oldOther,second);assert.equal(db.db.prepare('SELECT * FROM customer_close_requests WHERE ticket_id=?').get(ticket.id),undefined);
  saveSettings({telegramSharedTickets:true});await telegram.reconcileOperatorAccess();
  const cards=['7001','7002'].map(op=>getCard(ticket.id,op));assert.ok(cards.every(Boolean));
  await callback('close:'+ticket.id,getCard(ticket.id,'7002'),second);assert.equal(db.getTicketById.get(ticket.id).status,'open');
  await expireClose(ticket.id);assert.equal(db.getTicketById.get(ticket.id).status,'closed');
  assert.ok(cards.every(removed));
  db.closeTicket.run(unassigned.id);await telegram.notifyTicketClosed(db.getTicketById.get(unassigned.id));
 }finally{saveSettings({telegramSharedTickets:false});db.deactivateTelegramOperator.run('7002');await telegram.reconcileOperatorAccess();}
});

test('native menu transport failure retries without downgrading Rich or replacing the panel',async()=>{
 const panel=db.getTelegramOperatorDashboard.get('7001'),count=effects.filter(e=>e.kind==='rich').length;
 nativeNetworkFailures=1;
 await bot.handlers.message({message_id:610,chat:{id:7001,type:'private'},from:op,text:'/admin'});
 assert.equal(nativeNetworkFailures,0);assert.equal(telegram.status().richBlocksAvailable,true);
 assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,panel.dashboard_message_id);
 assert.equal(effects.filter(e=>e.kind==='rich').length,count);assert.equal(removed(panel.dashboard_message_id),false);
});

test('/admin replaces a deleted remote panel and keeps Rich blocks enabled',async()=>{
 const old=db.getTelegramOperatorDashboard.get('7001').dashboard_message_id;missingEdits.add(old);
 const before=effects.filter(e=>e.kind==='rich').length;
 await bot.handlers.message({message_id:611,chat:{id:7001,type:'private'},from:op,text:'/admin'});
 const panel=db.getTelegramOperatorDashboard.get('7001');assert.notEqual(panel.dashboard_message_id,old);
 assert.equal(effects.filter(e=>e.kind==='rich').length,before+1);assert.equal(telegram.status().richBlocksAvailable,true);
 await bot.handlers.message({message_id:612,chat:{id:7001,type:'private'},from:op,text:'/queue'});
 assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,panel.dashboard_message_id);
 assert.equal(effects.filter(e=>e.kind==='rich').length,before+1);missingEdits.delete(old);
});

test('/start reissues a fresh panel even when Telegram still accepts edits of the hidden old message',async()=>{
 const old=db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,before=effects.filter(e=>e.kind==='rich').length;
 await bot.handlers.message({message_id:613,chat:{id:7001,type:'private'},from:op,text:'/start'});
 const panel=db.getTelegramOperatorDashboard.get('7001');assert.notEqual(panel.dashboard_message_id,old);assert.ok(removed(old));
 const sent=effects.find(e=>e.id===panel.dashboard_message_id&&e.kind==='rich');assert.ok(sent.rich.blocks.some(b=>b.type==='buttons'));
 assert.equal(effects.filter(e=>e.kind==='rich').length,before+1);
 await callback('dashboard:refresh',panel.dashboard_message_id);assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,panel.dashboard_message_id);
});

test('unsupported native blocks fall back on the same panel without disabling Rich conversations',async()=>{
 const panel=db.getTelegramOperatorDashboard.get('7001');nativeValidationFailure=true;
 await callback('dashboard:refresh',panel.dashboard_message_id);
 const plain=effects.findLast(e=>e.kind==='edit'&&typeof e.text==='string');assert.match(plain.text,/KV9RU/);
 assert.ok(plain.options.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==='list:unanswered:0'));
 assert.equal(telegram.status().richBlocksAvailable,false);assert.equal(telegram.status().richMessagesAvailable,true);
 assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,panel.dashboard_message_id);
});
