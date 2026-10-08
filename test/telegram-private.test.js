const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-telegram-test-'));
process.env.DB_PATH = path.join(root, 'support.db');
process.env.TELEGRAM_BOT_TOKEN = 'fake-token';
process.env.TELEGRAM_ADMIN_IDS = '7001';
process.env.TELEGRAM_TOPIC_CREATE_RETRY_MS = '100';
process.env.TELEGRAM_TOPIC_CREATE_ATTEMPTS = '3';
process.env.TELEGRAM_CUSTOMER_SEND_INTERVAL_MS = '1';
process.env.TELEGRAM_FILE_DOWNLOAD_ATTEMPTS = '1';
process.env.PUBLIC_URL = 'https://support.example';
process.env.UPLOADS_DIR = path.join(root, 'uploads');

const sent = [];
const media = [];
let inboxFailuresRemaining=0;
const deletionFailures=new Set();
const rich = [];
const richDrafts = [];
const pins = [];
const unpins = [];
const edits = [];
const markupEdits = [];
const deleted = [];
const callbackAnswers = [];
const topicEdits = [];
const welcomeTickets = [];
const operatorWaits = [];
const socketEmits = [];
let topicAttempts = 0;
let nextTopicId = 500;
let messageId = 10;
let stopPollingCalls = 0;
let botOptions = null;
let richMessageFailuresRemaining = 0;
let sendMessageFailuresRemaining = 0;
let fileDownloadFailuresRemaining = 0;
const requests = [];
const originalFetch = global.fetch;
global.fetch = async url => {
  if (!String(url).startsWith('https://files.example/')) return originalFetch(url);
  if (fileDownloadFailuresRemaining > 0) {
    fileDownloadFailuresRemaining--;
    throw new Error('fetch failed');
  }
  return new Response(Buffer.from('fake-image-content'), {
    status: 200,
    headers: { 'content-type': 'image/jpeg', 'content-length': '18' }
  });
};

class FakeBot {
  constructor(_token, options) {
    botOptions = options;
    this.handlers = {};
  }
  _request(method, options) {
    requests.push({ method, options });
    return Promise.resolve();
  }
  on(name, handler) {
    this.handlers[name] = handler;
  }
  startPolling() {
    return Promise.resolve();
  }
  getWebhookInfo() {
    return Promise.resolve({url:''});
  }
  stopPolling() {
    stopPollingCalls++;
    return Promise.resolve();
  }
  getMe() {
    return Promise.resolve({ username: 'support_fake', has_topics_enabled: true });
  }
  setMyCommands() {
    return Promise.resolve();
  }
  setChatMenuButton() {
    return Promise.resolve();
  }
  getChat(id) {
    return Promise.resolve({ id, type: 'private', first_name: 'Оператор' });
  }
  getFileLink(fileId) {
    return Promise.resolve(`https://files.example/${fileId}`);
  }
  sendPhoto(chatId,file,options) {
    const sentMessageId=++messageId;
    media.push({chatId:String(chatId),file,options,messageId:sentMessageId});
    return Promise.resolve({message_id:sentMessageId});
  }
  sendDocument(...args){return this.sendPhoto(...args);}
  sendVideo(...args){return this.sendPhoto(...args);}
  sendAudio(...args){return this.sendPhoto(...args);}
  sendMessage(chatId, text, options) {
    if(options?.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data?.startsWith('reply:'))&&inboxFailuresRemaining>0) {
      inboxFailuresRemaining--;return Promise.reject(new Error('EFATAL: inbox transport failed'));
    }
    if (sendMessageFailuresRemaining > 0) {
      sendMessageFailuresRemaining--;
      return Promise.reject(new Error('EFATAL: fetch failed'));
    }
    const sentMessageId = ++messageId;
    sent.push({ chatId: String(chatId), text, options, messageId: sentMessageId });
    return Promise.resolve({ message_id: sentMessageId });
  }
  sendRichMessage(chatId, payload, options) {
    if (richMessageFailuresRemaining > 0) {
      richMessageFailuresRemaining--;
      return Promise.reject(new Error('EFATAL: fetch failed'));
    }
    const sentMessageId = ++messageId;
    rich.push({
      chatId: String(chatId),
      markdown: payload.markdown,
      options,
      messageId: sentMessageId
    });
    return Promise.resolve({ message_id: sentMessageId });
  }
  sendRichMessageDraft(chatId, draftId, payload, options) {
    richDrafts.push({ chatId: String(chatId), draftId, markdown: payload.markdown, options });
    return Promise.resolve(true);
  }
  editMessageText(text, options) {
    edits.push({ text, options });
    return Promise.resolve({});
  }
  editMessageReplyMarkup(replyMarkup, options) {
    markupEdits.push({ replyMarkup, options });
    return Promise.resolve({});
  }
  pinChatMessage(chatId, pinnedMessageId, options) {
    pins.push({ chatId: String(chatId), messageId: pinnedMessageId, options });
    return Promise.resolve();
  }
  unpinChatMessage(chatId, options) {
    unpins.push({ chatId: String(chatId), options });
    return Promise.resolve();
  }
  deleteMessage(chatId, deletedMessageId) {
    if(deletionFailures.has(Number(deletedMessageId)))return Promise.reject(new Error('EFATAL: delete failed'));
    deleted.push({ chatId: String(chatId), messageId: Number(deletedMessageId) });
    return Promise.resolve();
  }
  answerCallbackQuery(id, options) {
    callbackAnswers.push({ id, options });
    return Promise.resolve();
  }
  createForumTopic() {
    topicAttempts++;
    return topicAttempts === 1
      ? Promise.reject(new Error('temporary Telegram error'))
      : Promise.resolve({ message_thread_id: ++nextTopicId });
  }
  editForumTopic(chatId, threadId, options) {
    topicEdits.push({ chatId: String(chatId), threadId: Number(threadId), options });
    return Promise.resolve(true);
  }
  closeForumTopic() {
    return Promise.resolve();
  }
}

const telegramModule = require.resolve('node-telegram-bot-api');
require.cache[telegramModule] = {
  id: telegramModule,
  filename: telegramModule,
  loaded: true,
  exports: { TelegramBot: FakeBot }
};
const db = require('../src/database');
const { saveSettings } = require('../src/settings');
const { createTelegramPollingLease } = require('../src/telegram-lease');
const telegram = require('../src/telegram-private');
const fakeBot = telegram.init(
  {
    to: room => ({
      emit: (event, payload) => socketEmits.push({ room, event, payload })
    })
  },
  {
    scheduleWelcomeMessages: ticketId => welcomeTickets.push(ticketId),
    scheduleOperatorWaitMessage: (ticketId, afterMessageId) => {
      operatorWaits.push({ ticketId, afterMessageId });
    },
    getControlCenterStatus: () => ({
      health: {
        version: 'test-version',
        uptime: 120,
        realtime: { connectedClients: 3, transports: { websocket: 2, polling: 1 } }
      },
      maintenance: {
        config: { backupEnabled: true },
        lastBackupAt: new Date().toISOString(),
        disk: { usedPercent: 42, freeBytes: 2 * 1024 ** 3 }
      }
    })
  }
);
saveSettings({ workStartHour: 0, workEndHour: 24 });

test.after(async () => {
  await telegram.shutdown();
  global.fetch = originalFetch;
  if (db.db.open) db.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('long polling has its own HTTP timeout without delaying message delivery requests', async () => {
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(botOptions.request.timeoutMs, 15000);
  assert.equal(botOptions.polling.params.timeout, 30);

  await fakeBot._request('getUpdates', { form: {} });
  await fakeBot._request('getFile', { form: {} });
  await fakeBot._request('sendMessage', { form: {} });

  assert.equal(requests.at(-3).options.timeoutMs, 45000);
  assert.equal(requests.at(-2).options.timeoutMs, 45000);
  assert.equal(requests.at(-1).options.timeoutMs, undefined);
});

test('empty ticket creates a topic after a transient Telegram failure', async () => {
  await new Promise(resolve => setTimeout(resolve, 30));
  const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  db.createTicket.run(id, 'Пустой тикет', 'session-empty');
  const threadId = await telegram.createTopic(id);
  const ticket = db.getTicketById.get(id);
  const thread = db.getTelegramThreadForTicketOperator.get(id, '7001');

  assert.equal(threadId, 501);
  assert.equal(topicAttempts, 2);
  assert.ok(thread);
  assert.equal(ticket.assigned_operator_id, '7001');
  assert.equal(db.countMessages.get(id).cnt, 0);
  const intro = rich.find(item => item.options?.message_thread_id === 501);
  assert.ok(intro);
  assert.doesNotMatch(intro.markdown, /Клиент открыл новое обращение|^> /m);
  assert.match(intro.markdown, /Диалог/);
  assert.match(intro.markdown, /Пустой тикет/);
});


function inboxUserMessage(ticketId,id,text='Входящее сообщение',type='text',file=null) {
  db.saveMessage.run(id,ticketId,'user','Клиент',text,type,file,file?'photo.jpg':null,file?'image/jpeg':null,null,null);
  return db.getMessageById.get(id);
}
async function replyInMain(messageId,text,id,extra={}) {
  await fakeBot.handlers.message({message_id:id,chat:{id:7001,type:'private'},from:{id:7001,first_name:'Оператор'},
    ...(text?{text}:{}),reply_to_message:{message_id:messageId},...extra});
}
const inboxButton=id=>sent.findLast(item=>item.options?.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data==='reply:'+id));

test('each customer message appears in main chat with Reply while topic history remains',async()=>{
  const ticketId='inbox-live';db.createTicket.run(ticketId,'Клиент ленты','session-inbox-live');
  await telegram.createTopic(ticketId);
  for(const id of ['inbox-first','inbox-second']) {
    const message=inboxUserMessage(ticketId,id,'Сообщение '+id);
    await telegram.forwardMessage(db.getTicketById.get(ticketId),message);
    const item=inboxButton(id);assert.ok(item);assert.equal(item.options.message_thread_id,undefined);
    assert.match(item.text,new RegExp(id));assert.ok(db.getMessageById.get(id).telegram_message_id);
    const count=sent.filter(item=>item.options?.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data==='reply:'+id)).length;
    await telegram.forwardMessage(db.getTicketById.get(ticketId),db.getMessageById.get(id));
    assert.equal(sent.filter(item=>item.options?.reply_markup?.inline_keyboard?.flat().some(button=>button.callback_data==='reply:'+id)).length,count);
  }
});

test('Reply button opens ForceReply and routes text to the exact customer',async()=>{
  const source='inbox-first',item=inboxButton(source);
  await fakeBot.handlers.callback_query({id:'inbox-callback',from:{id:7001,first_name:'Оператор'},message:{chat:{id:7001,type:'private'},message_id:item.messageId},data:'reply:'+source});
  const prompt=sent.findLast(item=>item.options?.reply_markup?.force_reply);assert.ok(prompt);
  await replyInMain(prompt.messageId,'Ответ из общей ленты',19001);
  const response=db.getMessages.all('inbox-live').find(m=>m.content==='Ответ из общей ленты');
  assert.equal(response.reply_to_id,source);assert.equal(response.sender,'support');
  assert.ok(socketEmits.some(e=>e.room==='ticket:inbox-live'&&e.payload?.id===response.id));
  assert.equal(deleted.some(e=>e.messageId===item.messageId),false,'Keep source until web delivery acknowledgement');
  telegram.confirmWebCustomerDelivery('inbox-live',response.id);await telegram.processDeliveryQueue();
  for(const id of [item.messageId,prompt.messageId,19001])assert.ok(deleted.some(e=>e.chatId==='7001'&&e.messageId===id),'Delete delivered conversation from main: '+id);
  assert.ok(db.getMessageById.get(source));assert.ok(db.getMessageById.get(response.id));
  assert.equal(deleted.some(e=>e.messageId===inboxButton('inbox-second').messageId),false,'Unanswered other message stays');
});

test('native Reply with a photo works and deletes both messages only after delivery',async()=>{
  const item=inboxButton('inbox-second');await replyInMain(item.messageId,null,19002,{photo:[{file_id:'inbox-photo',file_size:18}]});
  const response=db.getMessageByTelegramDestination.get('7001',19002);assert.equal(response.ticket_id,'inbox-live');
  assert.equal(response.message_type,'image');assert.equal(response.reply_to_id,'inbox-second');assert.ok(fs.existsSync(path.join(process.env.UPLOADS_DIR,path.basename(response.file_url))));
  assert.equal(deleted.some(e=>e.messageId===19002),false);
  telegram.confirmWebCustomerDelivery('inbox-live',response.id);await telegram.processDeliveryQueue();
  assert.ok(deleted.some(e=>e.messageId===19002));assert.ok(deleted.some(e=>e.messageId===item.messageId));
});

test('main inbox retries persist independently of successful topic delivery',async()=>{
  const message=inboxUserMessage('inbox-live','inbox-retry','Повторная доставка');inboxFailuresRemaining=1;
  await telegram.forwardMessage(db.getTicketById.get('inbox-live'),message);
  assert.ok(db.getMessageById.get(message.id).telegram_message_id);assert.equal(inboxButton(message.id),undefined);
  const row=db.db.prepare('SELECT * FROM telegram_support_inbox WHERE message_id=?').get(message.id);
  assert.equal(row.attempts,1);assert.match(row.last_error,/inbox transport/);
  db.db.prepare('UPDATE telegram_support_inbox SET next_retry_at=CURRENT_TIMESTAMP WHERE message_id=?').run(message.id);
  await telegram.processDeliveryQueue();assert.ok(inboxButton(message.id));
});

test('closed/reassigned targets and untargeted text never leak to another customer',async()=>{
  const item=inboxButton('inbox-retry'),count=db.getMessages.all('inbox-live').length;
  await fakeBot.handlers.message({message_id:19003,chat:{id:7001,type:'private'},from:{id:7001,first_name:'Оператор'},text:'Без адресата'});
  assert.equal(db.getMessages.all('inbox-live').length,count);
  db.assignTicketIfUnassigned.run('7001','inbox-live');
  db.db.prepare('UPDATE tickets SET assigned_operator_id=? WHERE id=?').run('7002','inbox-live');
  await replyInMain(item.messageId,'Чужой тикет',19004);assert.equal(db.getMessages.all('inbox-live').length,count);
  db.db.prepare('UPDATE tickets SET assigned_operator_id=?,status=? WHERE id=?').run('7001','closed','inbox-live');
  await replyInMain(item.messageId,'Закрытый тикет',19005);assert.equal(db.getMessages.all('inbox-live').length,count);
  db.db.prepare('UPDATE tickets SET status=? WHERE id=?').run('open','inbox-live');
});

test('photo album keeps explicit recipient after its first delivered reply is cleaned',async()=>{
  const item=inboxButton('inbox-retry');
  await replyInMain(item.messageId,null,19006,{photo:[{file_id:'album-first',file_size:18}],media_group_id:'support-album'});
  const first=db.getMessageByTelegramDestination.get('7001',19006);telegram.confirmWebCustomerDelivery('inbox-live',first.id);await telegram.processDeliveryQueue();
  await fakeBot.handlers.message({message_id:19007,chat:{id:7001,type:'private'},from:{id:7001,first_name:'Оператор'},photo:[{file_id:'album-second',file_size:18}],media_group_id:'support-album'});
  const second=db.getMessageByTelegramDestination.get('7001',19007);assert.ok(second);assert.equal(second.reply_to_id,'inbox-retry');
  assert.equal(second.ticket_id,'inbox-live');telegram.confirmWebCustomerDelivery('inbox-live',second.id);await telegram.processDeliveryQueue();
  assert.ok(deleted.some(e=>e.messageId===19007));
});

test('incoming photo is copied to main with its own Reply button',async()=>{
  fs.mkdirSync(process.env.UPLOADS_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.UPLOADS_DIR,'inbox-fixture.jpg'),'test-photo');
  const message=inboxUserMessage('inbox-live','inbox-image','Скриншот','image','/uploads/inbox-fixture.jpg');
  await telegram.forwardMessage(db.getTicketById.get('inbox-live'),message);
  const item=media.find(item=>item.options?.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='reply:'+message.id));
  assert.ok(item);assert.equal(item.options.message_thread_id,undefined);assert.match(item.options.caption,/Скриншот/);
  await replyInMain(item.messageId,'Спасибо за скриншот',19008);
  assert.equal(db.getMessageByTelegramDestination.get('7001',19008).reply_to_id,message.id);
});

test('cleanup failure is persisted and retried without deleting an undelivered photo reply',async()=>{
  const item=inboxButton('inbox-retry');await replyInMain(item.messageId,'Очередь удаления',19009);
  const response=db.getMessageByTelegramDestination.get('7001',19009);
  deletionFailures.add(19009);
  try {
    telegram.confirmWebCustomerDelivery('inbox-live',response.id);await telegram.processDeliveryQueue();
    const record=db.db.prepare('SELECT * FROM telegram_support_reply_targets WHERE telegram_message_id=?').get(19009);
    assert.equal(record.cleanup_pending,1);assert.equal(record.cleanup_attempts,1);assert.match(record.cleanup_error,/confirm deletion/);
  }finally{deletionFailures.delete(19009);}
  db.db.prepare('UPDATE telegram_support_reply_targets SET cleanup_retry_at=CURRENT_TIMESTAMP WHERE telegram_message_id=?').run(19009);
  await telegram.processDeliveryQueue();assert.ok(deleted.some(e=>e.messageId===19009));
});

test('two operator inboxes preserve atomic claiming and reject the other operator reply',async()=>{
  db.saveManagedTelegramOperator.run('7002','Второй оператор',null,1,0);
  try {
    const ticketId='inbox-unassigned';db.createTicket.run(ticketId,'Новый клиент','session-inbox-unassigned');
    const message=inboxUserMessage(ticketId,'inbox-unassigned-message');await telegram.forwardMessage(db.getTicketById.get(ticketId),message);
    const items=sent.filter(i=>i.options?.reply_markup?.inline_keyboard?.flat().some(b=>b.callback_data==='reply:'+message.id));
    assert.equal(items.length,2);assert.deepEqual(new Set(items.map(i=>i.chatId)),new Set(['7001','7002']));
    const own=items.find(i=>i.chatId==='7001'),other=items.find(i=>i.chatId==='7002');
    await fakeBot.handlers.callback_query({id:'claim-inbox',from:{id:7001,first_name:'Оператор'},message:{chat:{id:7001,type:'private'},message_id:own.messageId},data:'reply:'+message.id});
    assert.equal(db.getTicketById.get(ticketId).assigned_operator_id,'7001');
    await fakeBot.handlers.message({message_id:19010,chat:{id:7002,type:'private'},from:{id:7002,first_name:'Второй оператор'},text:'Не мой тикет',reply_to_message:{message_id:other.messageId}});
    assert.equal(db.getMessages.all(ticketId).filter(m=>m.sender==='support').length,0);
    db.db.prepare("UPDATE tickets SET status='closed' WHERE id=?").run(ticketId);
  }finally{db.deactivateTelegramOperator.run('7002');}
});

test('an operator added from settings can use the bot without settings access', async () => {
  db.saveManagedTelegramOperator.run('7002', 'Новый оператор', null, 1, 0);

  await fakeBot.handlers.message({
    message_id: 702,
    chat: { id: 7002, type: 'private' },
    from: { id: 7002, first_name: 'Новый', last_name: 'оператор' },
    text: '/start'
  });

  const operator = db.getTelegramOperator.get('7002');
  assert.equal(operator.active, 1);
  assert.equal(operator.can_manage_settings, 0);
  assert.ok(rich.some(item => item.chatId === '7002'));
  const dashboard = db.getTelegramOperatorDashboard.get('7002');
  assert.ok(dashboard.dashboard_message_id);
  const dashboardCard = rich.findLast(item => item.chatId === '7002');
  assert.ok(dashboardCard.options?.reply_markup?.inline_keyboard?.flat().some(button =>
    button.callback_data === 'system:show'
  ));
  await fakeBot.handlers.callback_query({
    id: 'operator-system-query',
    from: { id: 7002, first_name: 'Новый', last_name: 'оператор' },
    message: { message_id: dashboard.dashboard_message_id, chat: { id: 7002, type: 'private' } },
    data: 'system:show'
  });
  const systemPanel = edits.findLast(item =>
    item.options?.message_id === dashboard.dashboard_message_id ||
    item.text?.message_id === dashboard.dashboard_message_id
  );
  const systemText = systemPanel.text?.rich_message?.markdown || systemPanel.text;
  assert.match(systemText, /Система и настройки/);
  assert.match(systemText, /Напоминания/);
  assert.match(systemText, /Realtime:\*\* 3 подключено · WS 2 \/ polling 1/);
  assert.ok(systemText.includes('test\\-version'));
  const richBeforeQueue = rich.length;
  await fakeBot.handlers.message({
    message_id: 703,
    chat: { id: 7002, type: 'private' },
    from: { id: 7002, first_name: 'Новый', last_name: 'оператор' },
    text: '/queue'
  });
  assert.equal(rich.length, richBeforeQueue, 'the operator dashboard is updated in place');
  assert.ok(edits.some(item =>
    item.options?.message_id === dashboard.dashboard_message_id ||
    item.text?.message_id === dashboard.dashboard_message_id
  ));
  db.deactivateTelegramOperator.run('7002');
});

test('a managed operator remains visible in the operator list after access is granted', () => {
  db.saveManagedTelegramOperator.run('7003', 'Видимый оператор', 'visible_operator', 1, 1);

  const operator = db.listTelegramOperators.all().find(item => item.telegram_user_id === '7003');
  assert.ok(operator);
  assert.equal(operator.display_name, 'Видимый оператор');
  assert.equal(operator.active, 1);
  assert.equal(operator.can_manage_settings, 1);

  db.deactivateTelegramOperator.run('7003');
});

test('the shared database lease allows only one polling owner', async () => {
  let secondStarted = false;
  const secondLease = createTelegramPollingLease({
    database: db,
    retryMs: 60000,
    onAcquired: () => { secondStarted = true; },
    logPrefix: '[TG standby test]'
  });
  secondLease.start();
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(secondStarted, false);
  assert.equal(secondLease.status().owner, false);
  await secondLease.stop();
});

test('an operator reply from a Telegram topic is persisted and emitted to the web customer', async () => {
  const ticketId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const messagesBefore = db.getMessages.all(ticketId).length;
  await fakeBot.handlers.message({
    message_id: 880,
    message_thread_id: 501,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    text: 'Ответ через Telegram'
  });

  const messages = db.getMessages.all(ticketId);
  assert.equal(messages.length, messagesBefore + 1);
  assert.equal(messages.at(-1).sender, 'support');
  assert.equal(messages.at(-1).content, 'Ответ через Telegram');
  assert.ok(socketEmits.some(item =>
    item.room === `ticket:${ticketId}` &&
    item.event === 'message' &&
    item.payload?.content === 'Ответ через Telegram'
  ));
  // The operator source text stays in Telegram until the customer channel
  // acknowledges rendering the persisted message.
  assert.equal(deleted.some(item => item.chatId === '7001' && item.messageId === 880), false);
  assert.equal(telegram.confirmWebCustomerDelivery(ticketId, messages.at(-1).id), true);
  await telegram.processDeliveryQueue();
  assert.ok(deleted.some(item => item.chatId === '7001' && item.messageId === 880));
  assert.ok(edits.some(item => item.text?.rich_message?.markdown?.includes('Ответ через Telegram')));

  await fakeBot.handlers.message({
    message_id: 880,
    message_thread_id: 501,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    text: 'Ответ через Telegram'
  });
  assert.equal(db.getMessages.all(ticketId).length, messagesBefore + 1);
});

test('rapid operator messages are processed in their Telegram order', async () => {
  const id = 'ordered-telegram-messages-0000-000000000000';
  db.createTicket.run(id, 'Порядок', 'session-ordered-telegram');
  db.assignTicket.run('7001', id);
  db.saveTelegramThread.run(id, '7001', '7001', 911, null);

  const first = fakeBot.handlers.message({
    message_id: 981,
    message_thread_id: 911,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    text: 'Первое по порядку'
  });
  const second = fakeBot.handlers.message({
    message_id: 982,
    message_thread_id: 911,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    text: 'Второе по порядку'
  });
  await Promise.all([first, second]);

  assert.deepEqual(
    db.getMessages.all(id).map(message => message.content),
    ['Первое по порядку', 'Второе по порядку']
  );
});

test('an operator photo survives exhausted live retries and is recovered from the durable queue', async () => {
  const id = 'durable-telegram-media-0000-000000000000';
  db.createTicket.run(id, 'Медиа', 'session-durable-telegram-media');
  db.assignTicket.run('7001', id);
  db.saveTelegramThread.run(id, '7001', '7001', 912, null);
  const update = {
    message_id: 983,
    message_thread_id: 912,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    caption: 'Скриншот решения',
    photo: [{ file_id: 'photo-file-983', width: 800, height: 600 }]
  };

  fileDownloadFailuresRemaining = 3;
  await fakeBot.handlers.message(update);
  assert.equal(db.getMessages.all(id).length, 0);
  const queued = db.getTelegramIncomingMessage.get('7001', 983);
  assert.ok(queued);
  assert.equal(queued.attempts, 1);

  db.db.prepare(`
    UPDATE telegram_incoming_message_queue
    SET next_retry_at = datetime('now', '-1 second')
    WHERE chat_id = ? AND message_id = ?
  `).run('7001', 983);
  await telegram.processIncomingRetryQueue();

  const recovered = db.getMessages.all(id).at(-1);
  assert.equal(recovered?.content, 'Скриншот решения');
  assert.equal(recovered?.message_type, 'image');
  assert.match(recovered?.file_url || '', /^\/uploads\/tg_/);
  assert.equal(db.getTelegramIncomingMessage.get('7001', 983), undefined);
  assert.ok(socketEmits.some(item =>
    item.room === `ticket:${id}` &&
    item.event === 'message' &&
    item.payload?.message_type === 'image'
  ));
});

test('Telegram service messages are removed before bot and topic routing', async () => {
  const serviceUpdates = [
    { pinned_message: { message_id: 1 } },
    { forum_topic_edited: { name: '🔵 Тикет' } },
    { forum_topic_closed: {} },
    { forum_topic_reopened: {} },
    { general_forum_topic_hidden: {} },
    { general_forum_topic_unhidden: {} }
  ];

  for (const [index, service] of serviceUpdates.entries()) {
    const serviceMessageId = 900 + index;
    await fakeBot.handlers.message({
      message_id: serviceMessageId,
      message_thread_id: 501,
      chat: { id: 7001, type: 'private' },
      from: { id: 9999, is_bot: true },
      ...service
    });
    assert.ok(deleted.some(item =>
      item.chatId === '7001' && item.messageId === serviceMessageId
    ));
  }

  saveSettings({ telegramDeleteRenameNotices: false });
  await fakeBot.handlers.message({
    message_id: 950,
    chat: { id: 7001, type: 'private' },
    from: { id: 9999, is_bot: true },
    pinned_message: { message_id: 2 }
  });
  assert.equal(deleted.some(item => item.messageId === 950), false);
  saveSettings({ telegramDeleteRenameNotices: true });
});

test('unanswered reminder is loud and stops after a support response', async () => {
  const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  db.createTicket.run(id, 'Ожидающий клиент', 'session-reminder-test');
  db.assignTicket.run('7001', id);
  db.db.prepare("UPDATE tickets SET created_at=datetime('now','-10 minutes') WHERE id=?").run(id);

  const count = await telegram.processUnansweredReminders();
  const reminder = sent.find(item => item.text.includes('ждёт ответа'));
  assert.equal(count, 1);
  assert.ok(reminder);
  assert.equal(reminder.options.disable_notification, false);
  assert.ok(reminder.options.reply_markup.inline_keyboard.length);

  const firstReminderId = db.getTelegramReminder.get(id, '7001').message_id;
  db.db.prepare("UPDATE tickets SET telegram_last_reminded_at=datetime('now','-10 minutes') WHERE id=?").run(id);
  assert.equal(await telegram.processUnansweredReminders(), 1);
  const secondReminderId = db.getTelegramReminder.get(id, '7001').message_id;
  assert.notEqual(secondReminderId, firstReminderId);
  assert.ok(deleted.some(item => item.chatId === '7001' && item.messageId === firstReminderId));

  db.saveMessage.run(
    'support-answer',
    id,
    'support',
    'Оператор',
    'Ответ',
    'text',
    null,
    null,
    null,
    null,
    null
  );
  await telegram.clearTicketReminders(id);
  assert.equal(db.getTelegramReminder.get(id, '7001'), undefined);
  db.db.prepare("UPDATE tickets SET telegram_last_reminded_at=datetime('now','-10 minutes') WHERE id=?").run(id);
  assert.equal(await telegram.processUnansweredReminders(), 0);
});

test('unanswered reminders pause outside configured working hours', async () => {
  const previous = saveSettings({});
  const id = 'offhours-reminder-ticket-000000000000';
  try {
    saveSettings({ timezone: 'UTC', workStartHour: 8, workEndHour: 23 });
    db.createTicket.run(id, 'Ночной клиент', 'session-offhours-reminder');
    db.assignTicket.run('7001', id);
    db.db.prepare("UPDATE tickets SET created_at=datetime('now','-10 minutes') WHERE id=?").run(id);

    assert.equal(
      await telegram.processUnansweredReminders(new Date('2026-09-02T02:00:00Z')),
      0
    );
    assert.equal(db.getTelegramReminder.get(id, '7001'), undefined);
    const reminderHealth = telegram.status(new Date('2026-09-02T02:00:00Z')).reminders;
    assert.equal(reminderHealth.workHoursOnly, true);
    assert.equal(reminderHealth.pausedOutsideWorkHours, true);
    assert.equal(reminderHealth.timezone, 'UTC');
  } finally {
    saveSettings(previous);
    db.closeTicket.run(id);
  }
});

test('a close-ticket proposal counts as the latest support action', async () => {
  const id = 'close-prompt-reminder-ticket-00000000';
  db.createTicket.run(id, 'Клиент с предложением', 'session-close-prompt-reminder');
  db.assignTicket.run('7001', id);
  db.saveMessage.run(
    'close-prompt-reminder-user-message',
    id,
    'user',
    'Клиент',
    'Спасибо, проверяю',
    'text',
    null,
    null,
    null,
    null,
    null
  );
  db.db.prepare("UPDATE messages SET created_at=datetime('now','-10 minutes') WHERE id=?")
    .run('close-prompt-reminder-user-message');
  assert.ok(db.getTicketsAwaitingTelegramReminder.all('-3 minutes', '-5 minutes', 100)
    .some(ticket => ticket.id === id));

  await telegram.sendCustomerClosePrompt(db.getTicketById.get(id));

  const prompt = db.getMessages.all(id).find(message => message.message_type === 'close_prompt');
  assert.ok(prompt);
  assert.equal(prompt.sender, 'system');
  assert.equal(db.getTicketsAwaitingTelegramReminder.all('-3 minutes', '-5 minutes', 100)
    .some(ticket => ticket.id === id), false);
  const adminTicket = db.getTicketsForAdmin.all().find(ticket => ticket.id === id);
  assert.equal(adminTicket.unread_count, 0);
});

test('Telegram customer creates a ticket and receives the support reply', async () => {
  const customerId = '8002';
  await fakeBot.handlers.message({
    message_id: 801,
    chat: { id: customerId, type: 'private' },
    from: {
      id: Number(customerId),
      first_name: 'Анна',
      last_name: 'Клиент',
      username: 'anna_client',
      language_code: 'ru'
    },
    text: 'Нужна помощь с подключением'
  });

  const ticket = db.getOpenTicketByTelegramCustomer.get(customerId);
  assert.ok(ticket);
  assert.equal(ticket.source, 'telegram');
  assert.equal(ticket.telegram_customer_username, 'anna_client');
  assert.equal(ticket.telegram_customer_language_code, 'ru');
  assert.equal(ticket.assigned_operator_id, '7001');
  const control = rich.find(item =>
    item.chatId === customerId &&
    item.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'customer:close'
  );
  assert.match(control.markdown, new RegExp(`#${ticket.id.slice(0, 8)}`));
  assert.equal(
    control.options.reply_markup.inline_keyboard[0][0].callback_data,
    'customer:close'
  );
  assert.equal(ticket.telegram_customer_control_message_id, control.messageId);
  assert.ok(pins.some(item =>
    item.chatId === customerId &&
    item.messageId === ticket.telegram_customer_control_message_id
  ));
  assert.deepEqual(welcomeTickets, [ticket.id]);
  let userMessage = db.getMessages.all(ticket.id).find(message => message.sender === 'user');
  for (let attempt = 0; attempt < 20 && !userMessage?.telegram_message_id; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    userMessage = db.getMessageById.get(userMessage.id);
  }
  assert.equal(userMessage.content, 'Нужна помощь с подключением');
  assert.equal(userMessage.telegram_source_message_id, 801);
  assert.ok(userMessage.telegram_message_id);
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  const operatorDelivery = rich.find(item =>
    item.messageId === thread.root_message_id &&
    item.options?.reply_markup?.inline_keyboard?.flat().some(button =>
      button.web_app?.url?.includes(`ticket=${ticket.id}`) && button.text.includes('Открыть чат')
    )
  );
  assert.ok(operatorDelivery, 'each customer message has a direct Mini App chat button');
  assert.ok(edits.some(item => item.text?.rich_message?.markdown?.includes('Нужна помощь с подключением')));
  const transcript = edits.findLast(item =>
    item.text?.rich_message?.markdown?.includes('Нужна помощь с подключением')
  )?.text.rich_message.markdown;
  assert.match(transcript, /\*\*👤 Анна Клиент\*\* · _\d{2}:\d{2}_/);
  assert.equal(
    rich.filter(item =>
      item.chatId === '7001' && item.markdown.includes('Нужна помощь с подключением')
    ).length,
    1,
    'the customer text is kept in the single Rich transcript'
  );
  assert.ok(operatorWaits.some(item =>
    item.ticketId === ticket.id && item.afterMessageId === userMessage.id
  ));

  const supportId = 'support-to-telegram-customer';
  db.saveMessage.run(
    supportId,
    ticket.id,
    'support',
    'Оператор',
    'Проверяем подключение',
    'text',
    null,
    null,
    null,
    null,
    null
  );
  await telegram.deliverCustomerReply(ticket, db.getMessageById.get(supportId));
  const delivery = db.getMessageById.get(supportId);
  assert.ok(delivery.telegram_customer_message_id);
  const supportDelivery = sent.find(item =>
    item.chatId === customerId && item.text.includes('Проверяем подключение')
  );
  assert.ok(supportDelivery);
  assert.equal(supportDelivery.options?.reply_markup, undefined);
  await fakeBot.handlers.message({
    message_id: 9801,
    message_thread_id: thread.thread_id,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    text: 'Ответ из темы оператора'
  });
  let topicReply = db.getMessages.all(ticket.id).find(message =>
    message.content === 'Ответ из темы оператора'
  );
  for (let attempt = 0; attempt < 80 && !topicReply?.telegram_customer_message_id; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    topicReply = db.getMessageById.get(topicReply.id);
  }
  assert.ok(topicReply?.telegram_customer_message_id);
  assert.ok(sent.some(item =>
    item.chatId === customerId && item.text.includes('Ответ из темы оператора')
  ));
  assert.ok(rich.some(item =>
    item.options?.reply_markup?.inline_keyboard?.flat().some(button =>
      button.callback_data === `ticketmenu:${ticket.id}`
    )
  ));

  await fakeBot.handlers.callback_query({
    id: 'ticket-menu-query',
    from: { id: 7001, first_name: 'Оператор' },
    message: {
      message_id: operatorDelivery.messageId,
      message_thread_id: operatorDelivery.options.message_thread_id,
      chat: { id: 7001, type: 'private' }
    },
    data: `ticketmenu:${ticket.id}`
  });
  const expandedActions = markupEdits.find(item =>
    item.options?.message_id === operatorDelivery.messageId
  )?.replyMarkup.inline_keyboard.flat();
  assert.ok(expandedActions?.some(button => button.callback_data === `close:${ticket.id}`));
  assert.ok(expandedActions?.some(button => button.callback_data === `customercontrol:${ticket.id}`));
  assert.ok(expandedActions?.some(button => button.callback_data === `ticketmain:${ticket.id}`));

  const countBeforeDuplicate = db.getMessages.all(ticket.id).length;
  await fakeBot.handlers.message({
    message_id: 801,
    chat: { id: customerId, type: 'private' },
    from: { id: Number(customerId), first_name: 'Анна', username: 'anna_client' },
    text: 'Нужна помощь с подключением'
  });
  assert.equal(db.getMessages.all(ticket.id).length, countBeforeDuplicate);

  const pinsBeforeOperatorAction = pins.length;
  const controlBeforeOperatorAction = ticket.telegram_customer_control_message_id;
  await fakeBot.handlers.callback_query({
    id: 'customer-control-query',
    from: { id: 7001, first_name: 'Оператор' },
    message: { chat: { id: 7001, type: 'private' } },
    data: `customercontrol:${ticket.id}`
  });
  const refreshedTicket = db.getTicketById.get(ticket.id);
  assert.notEqual(
    refreshedTicket.telegram_customer_control_message_id,
    controlBeforeOperatorAction
  );
  assert.ok(deleted.some(item =>
    item.chatId === customerId && item.messageId === controlBeforeOperatorAction
  ));
  assert.ok(unpins.some(item => item.chatId === customerId));
  assert.ok(pins.length > pinsBeforeOperatorAction);
  const closePrompt = rich.find(item =>
    item.chatId === customerId &&
    item.messageId === refreshedTicket.telegram_customer_control_message_id
  );
  assert.ok(db.getMessages.all(ticket.id).some(message => message.message_type === 'close_prompt'));
  assert.match(closePrompt.markdown, /Спасибо за обращение/);
  assert.match(closePrompt.markdown, /Если ваш вопрос решён/);
  assert.doesNotMatch(closePrompt.markdown, /Тикет #|Оператор уже получил|Статус:/);

  const activeControlMessageId = refreshedTicket.telegram_customer_control_message_id;
  await fakeBot.handlers.callback_query({
    id: 'customer-close-query',
    from: { id: Number(customerId), first_name: 'Анна' },
    message: {
      message_id: activeControlMessageId,
      chat: { id: Number(customerId), type: 'private' }
    },
    data: 'customer:close'
  });
  const closedTicket = db.getTicketById.get(ticket.id);
  assert.equal(closedTicket.status, 'closed');
  assert.ok(deleted.some(item => item.messageId === 801));
  assert.ok(deleted.some(item => item.messageId === delivery.telegram_customer_message_id));
  assert.ok(deleted.some(item => item.messageId === activeControlMessageId));
  const launcher = rich.findLast(item =>
    item.chatId === customerId &&
    item.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'customer:new'
  );
  assert.ok(launcher);
  assert.match(launcher.markdown, /Вы закрыли тикет/);
  assert.equal(closedTicket.telegram_customer_control_message_id, launcher.messageId);

  await fakeBot.handlers.callback_query({
    id: 'customer-new-query',
    from: { id: Number(customerId), first_name: 'Анна', username: 'anna_client' },
    message: {
      message_id: launcher.messageId,
      chat: { id: Number(customerId), type: 'private' }
    },
    data: 'customer:new'
  });
  const newTicketByButton = db.getOpenTicketByTelegramCustomer.get(customerId);
  assert.ok(newTicketByButton, 'customer:new creates a new open ticket');
  assert.ok(rich.some(item =>
    item.chatId === customerId &&
    item.messageId === newTicketByButton.telegram_customer_control_message_id &&
    item.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'customer:close'
  ));
});

test('main-chat answer to a Telegram customer is cleaned only after confirmed send',async()=>{
  await fakeBot.handlers.message({message_id:19100,chat:{id:8199,type:'private'},from:{id:8199,first_name:'Клиент главной ленты'},text:'Тест доставки из ленты'});
  const ticket=db.getOpenTicketByTelegramCustomer.get('8199');
  let source;
  for(let i=0;i<80;i++) {
    source=db.getMessages.all(ticket.id).find(m=>m.sender==='user');
    if(source&&inboxButton(source.id)&&db.getTicketById.get(ticket.id).assigned_operator_id)break;
    await new Promise(r=>setTimeout(r,5));
  }
  const item=inboxButton(source.id);assert.ok(item);
  const message={message_id:19101,chat:{id:7001,type:'private'},from:{id:7001,first_name:'Оператор'},text:'Ответ с гарантией доставки',reply_to_message:{message_id:item.messageId}};
  sendMessageFailuresRemaining=1;
  await fakeBot.handlers.message(message);
  let response=db.getMessageByTelegramDestination.get('7001',19101);
  for(let i=0;i<80&&!response.telegram_customer_attempts;i++){await new Promise(r=>setTimeout(r,5));response=db.getMessageById.get(response.id);}
  assert.equal(response.telegram_customer_message_id,null);assert.equal(deleted.some(e=>e.messageId===item.messageId),false);assert.equal(deleted.some(e=>e.messageId===19101),false);
  db.db.prepare('UPDATE messages SET telegram_customer_next_retry_at=CURRENT_TIMESTAMP WHERE id=?').run(response.id);
  for(let i=0;i<150;i++) {
    await telegram.processDeliveryQueue();response=db.getMessageById.get(response.id);
    if(response.telegram_customer_message_id&&deleted.some(e=>e.messageId===19101))break;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.ok(response.telegram_customer_message_id);assert.ok(deleted.some(e=>e.messageId===item.messageId));assert.ok(deleted.some(e=>e.messageId===19101));
  const count=db.getMessages.all(ticket.id).length;await fakeBot.handlers.message(message);assert.equal(db.getMessages.all(ticket.id).length,count,'Duplicate Telegram update never sends twice');
  db.db.prepare("UPDATE tickets SET status='closed' WHERE id=?").run(ticket.id);
});

test('rapid operator replies to one customer are serialized and kept in order', async () => {
  const ticketId = 'customer-delivery-order-ticket-00000000000';
  db.createTelegramTicket.run(ticketId, 'Очередь', 'customer-delivery-order-session', '8015', '8015', null, 'Очередь', null, 'ru');
  const ticket = db.getTicketById.get(ticketId);
  const messages = ['Первое', 'Второе', 'Третье'].map((content, index) => {
    const id = `customer-delivery-order-${index}`;
    db.saveMessage.run(id, ticketId, 'support', 'Оператор', content, 'text', null, null, null, null, null);
    return db.getMessageById.get(id);
  });

  const before = sent.length;
  await Promise.all(messages.map(message => telegram.deliverCustomerReply(ticket, message)));
  const delivered = sent.slice(before)
    .filter(item => item.chatId === '8015')
    .map(item => item.text.match(/Первое|Второе|Третье/)?.[0])
    .filter(Boolean);
  assert.deepEqual(delivered, ['Первое', 'Второе', 'Третье']);
  for (const message of messages) {
    assert.ok(db.getMessageById.get(message.id).telegram_customer_message_id);
  }
});

test('/start immediately creates a ticket and replaces the command with a Rich control', async () => {
  const customerId = '8004';
  await fakeBot.handlers.message({
    message_id: 804,
    chat: { id: customerId, type: 'private' },
    from: { id: Number(customerId), first_name: 'Мария', language_code: 'ru' },
    text: '/start'
  });

  const ticket = db.getOpenTicketByTelegramCustomer.get(customerId);
  assert.ok(ticket);
  assert.ok(deleted.some(item => item.chatId === customerId && item.messageId === 804));
  const control = rich.find(item =>
    item.chatId === customerId &&
    item.messageId === ticket.telegram_customer_control_message_id
  );
  assert.ok(control);
  assert.match(control.markdown, /Тикет .* создан/);
  assert.equal(
    control.options.reply_markup.inline_keyboard[0][0].callback_data,
    'customer:close'
  );

  db.closeTicket.run(ticket.id);
  await telegram.notifyTicketClosed(ticket, {
    customerReason: 'Тикет закрыл оператор поддержки.'
  });
  const launcher = rich.findLast(item =>
    item.chatId === customerId &&
    item.options?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === 'customer:new'
  );
  assert.ok(launcher);
  assert.match(launcher.markdown, /закрыл оператор/);
  assert.ok(deleted.some(item =>
    item.chatId === customerId &&
    item.messageId === control.messageId
  ));
});

test('a customer message opens a new ticket after a previous ticket was closed', async () => {
  const customerId = '8005';
  await fakeBot.handlers.message({
    message_id: 805,
    chat: { id: customerId, type: 'private' },
    from: { id: Number(customerId), first_name: 'Ольга' },
    text: '/start'
  });
  const previous = db.getOpenTicketByTelegramCustomer.get(customerId);
  assert.ok(previous);
  db.closeTicket.run(previous.id);

  await fakeBot.handlers.message({
    message_id: 806,
    chat: { id: customerId, type: 'private' },
    from: { id: Number(customerId), first_name: 'Ольга' },
    text: 'Хочу открыть новое обращение'
  });

  const current = db.getOpenTicketByTelegramCustomer.get(customerId);
  assert.ok(current);
  assert.notEqual(current.id, previous.id);
  assert.equal(
    db.getMessages.all(current.id).find(message => message.sender === 'user').content,
    'Хочу открыть новое обращение'
  );
});

test('close button responds immediately and closes a ticket from its operator topic', async () => {
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  db.createTicket.run(id, 'Закрытие из темы', 'session-close-button');
  db.saveTelegramThread.run(id, '7001', '7001', 909, null);

  const answersBefore = callbackAnswers.length;
  await fakeBot.handlers.callback_query({
    id: 'close-ticket-query',
    from: { id: 7001, first_name: 'Оператор' },
    message: {
      chat: { id: 7001, type: 'private' },
      message_thread_id: 909
    },
    data: `close:${id}`
  });

  assert.equal(callbackAnswers.length, answersBefore + 1);
  assert.equal(callbackAnswers.at(-1).id, 'close-ticket-query');
  assert.match(callbackAnswers.at(-1).options.text, /Закрываю тикет/);
  assert.equal(db.getTicketById.get(id).status, 'closed');
  const closeNotice = rich.findLast(item =>
    item.chatId === '7001' && item.options?.message_thread_id === 909
  );
  assert.ok(closeNotice);
  assert.equal(
    closeNotice.options?.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data),
    false
  );
});

test('operator menu sends a gratitude close prompt to a website customer', async () => {
  const id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  db.createTicket.run(id, 'Веб-клиент', 'session-web-close-prompt');
  db.assignTicket.run('7001', id);

  await fakeBot.handlers.callback_query({
    id: 'web-ticket-menu-query',
    from: { id: 7001, first_name: 'Оператор' },
    message: { message_id: 990, chat: { id: 7001, type: 'private' } },
    data: `ticketmenu:${id}`
  });
  const menu = markupEdits.findLast(item => item.options?.message_id === 990)?.replyMarkup.inline_keyboard.flat();
  assert.ok(menu?.some(button => button.web_app?.url?.includes(`ticket=${id}`)));
  assert.ok(menu?.some(button => button.callback_data === `customercontrol:${id}`));
  assert.ok(menu?.some(button => button.callback_data === `ticketmain:${id}`));

  await fakeBot.handlers.callback_query({
    id: 'web-customer-control-query',
    from: { id: 7001, first_name: 'Оператор' },
    message: { chat: { id: 7001, type: 'private' } },
    data: `customercontrol:${id}`
  });

  const prompt = db.getMessages.all(id).find(message => message.message_type === 'close_prompt');
  assert.ok(prompt);
  assert.match(prompt.content, /Спасибо за обращение/);
  assert.match(prompt.content, /Если ваш вопрос решён/);
  assert.ok(socketEmits.some(item =>
    item.room === `ticket:${id}` && item.event === 'message' && item.payload?.id === prompt.id
  ));
});

test('single-operator auto assignment can be disabled in settings', async () => {
  saveSettings({ telegramAutoAssignSingleOperator: false });
  const customerId = '8003';
  await fakeBot.handlers.message({
    message_id: 802,
    chat: { id: customerId, type: 'private' },
    from: { id: Number(customerId), first_name: 'Иван', language_code: 'ru' },
    text: 'Новый вопрос'
  });
  const ticket = db.getOpenTicketByTelegramCustomer.get(customerId);
  assert.ok(ticket);
  assert.equal(ticket.assigned_operator_id, null);
  assert.ok(rich.some(item =>
    item.chatId === '7001' && item.markdown.includes('Ждёт оператора')
  ));
  saveSettings({ telegramAutoAssignSingleOperator: true });
});

test('Rich transcript settings immediately control the operator ticket card', async () => {
  const previous = saveSettings({});
  try {
    saveSettings({
      telegramRichTranscriptTitle: 'Журнал {name}',
      telegramRichTranscriptSubtitle: 'Статус: {status}',
      telegramRichTranscriptMaxMessages: 2,
      telegramRichTranscriptMessageMaxChars: 80,
      telegramRichTranscriptShowHeader: true,
      telegramRichTranscriptShowSubtitle: true,
      telegramRichTranscriptTitleSize: 'large',
      telegramRichTranscriptTitleStyle: 'plain',
      telegramRichTranscriptSubtitleStyle: 'code',
      telegramRichTranscriptMessageLayout: 'quote',
      telegramRichTranscriptMessageSize: 'normal',
      telegramRichTranscriptMessageHeaderStyle: 'italic',
      telegramRichTranscriptShowAuthor: true,
      telegramRichTranscriptShowTime: false,
      telegramRichTranscriptTimestampFormat: 'time',
      telegramRichTranscriptUserLabel: 'Клиент: {name}',
      telegramRichTranscriptOperatorLabel: 'Оператор: {name}',
      telegramRichTranscriptShowMediaLabel: true,
      telegramRichTranscriptShowOmittedNotice: true,
      telegramRichTranscriptSeparator: 'dots',
      telegramRichTranscriptDensity: 'normal',
      telegramRichTranscriptOrder: 'oldest_first',
      telegramRichTranscriptFooter: 'Показано {shown} из {total}'
    });
    const id = 'rich-settings-ticket-0000-0000-000000000000';
    db.createTicket.run(id, 'Настройка', 'session-rich-settings');
    db.assignTicket.run('7001', id);
    db.saveTelegramThread.run(id, '7001', '7001', 919, null);
    db.saveMessage.run('rich-settings-user', id, 'user', 'Настройка', 'Первое сообщение', 'text', null, null, null, null, null);
    db.saveMessage.run('rich-settings-support', id, 'support', 'Оператор', 'Второе сообщение', 'text', null, null, null, null, null);

    await telegram.refreshOpenTicketTranscripts();
    const card = rich.findLast(item => item.options?.message_thread_id === 919);
    assert.ok(card);
    assert.match(card.markdown, /# Журнал Настройка/);
    assert.match(card.markdown, /`Статус: 🔵 открыт`/);
    assert.match(card.markdown, /> _Клиент: Настройка_[\s\S]*Первое сообщение/);
    assert.match(card.markdown, /> _Оператор: Оператор_[\s\S]*Второе сообщение/);
    assert.match(card.markdown, /· · ·/);
    assert.match(card.markdown, /Показано 2 из 2/);
  } finally {
    saveSettings(previous);
  }
});

test('Rich transcript displays database timestamps in the configured timezone', async () => {
  const previous = saveSettings({});
  try {
    saveSettings({
      timezone: 'Europe/Moscow',
      telegramRichTranscriptShowTime: true,
      telegramRichTranscriptTimestampFormat: 'time'
    });
    const id = 'rich-timezone-ticket-0000-000000000000';
    db.createTicket.run(id, 'Время', 'session-rich-timezone');
    db.assignTicket.run('7001', id);
    db.saveTelegramThread.run(id, '7001', '7001', 920, null);
    db.saveMessage.run('rich-timezone-message', id, 'user', 'Время', 'Проверка времени', 'text', null, null, null, null, null);
    db.db.prepare("UPDATE messages SET created_at = '2026-08-06 12:15:00' WHERE id = ?").run('rich-timezone-message');

    await telegram.refreshOpenTicketTranscripts();
    const card = rich.findLast(item => item.options?.message_thread_id === 920);
    assert.ok(card);
    assert.match(card.markdown, /15:15/);
  } finally {
    saveSettings(previous);
  }
});

test('Rich transcript groups consecutive messages and keeps only time in continuations', async () => {
  const previous = saveSettings({});
  try {
    saveSettings({
      telegramRichTranscriptShowAuthor: true,
      telegramRichTranscriptShowTime: true,
      telegramRichTranscriptAuthorMode: 'grouped',
      telegramRichTranscriptGroupWindowMinutes: 10,
      telegramRichTranscriptGroupContinuation: 'time',
      telegramRichTranscriptGroupSpacing: 'compact',
      telegramRichTranscriptMessageLayout: 'plain'
    });
    const id = 'rich-group-ticket-0000-000000000000';
    db.createTicket.run(id, 'Группа', 'session-rich-group');
    db.assignTicket.run('7001', id);
    db.saveTelegramThread.run(id, '7001', '7001', 921, null);
    db.saveMessage.run('rich-group-1', id, 'user', 'Группа', 'Первая реплика', 'text', null, null, null, null, null);
    db.saveMessage.run('rich-group-2', id, 'user', 'Группа', 'Вторая реплика', 'text', null, null, null, null, null);
    db.db.prepare("UPDATE messages SET created_at = '2026-08-06 12:15:00' WHERE id = ?").run('rich-group-1');
    db.db.prepare("UPDATE messages SET created_at = '2026-08-06 12:16:00' WHERE id = ?").run('rich-group-2');

    await telegram.refreshOpenTicketTranscripts();
    const card = rich.findLast(item => item.options?.message_thread_id === 921);
    assert.ok(card);
    assert.match(card.markdown, /\*\*👤 Группа\*\* · _15:15_[\s\S]*Первая реплика/);
    assert.match(card.markdown, /_15:16_[\s\S]*Вторая реплика/);
    assert.equal((card.markdown.match(/👤 Группа/g) || []).length, 1);
  } finally {
    saveSettings(previous);
  }
});

test('Rich transcript uses the customer name in the default client label', async () => {
  const previous = saveSettings({});
  try {
    saveSettings({
      telegramRichTranscriptUserLabel: '👤 {name}',
      telegramRichTranscriptShowAuthor: true,
      telegramRichTranscriptShowTime: false
    });
    const id = 'rich-customer-name-ticket-0000-000000000';
    db.createTicket.run(id, 'Имя из Telegram', 'session-rich-customer-name');
    db.assignTicket.run('7001', id);
    db.saveTelegramThread.run(id, '7001', '7001', 922, null);
    db.saveMessage.run('rich-customer-name-message', id, 'user', 'Имя из Telegram', 'Здравствуйте', 'text', null, null, null, null, null);

    await telegram.refreshOpenTicketTranscripts();
    const card = rich.findLast(item => item.options?.message_thread_id === 922);
    assert.ok(card);
    assert.match(card.markdown, /👤 Имя из Telegram/);
    assert.doesNotMatch(card.markdown, /👤 Клиент/);
  } finally {
    saveSettings(previous);
  }
});

test('Rich transcript can stream an optional native entry effect without replacing the final card', async () => {
  const previous = saveSettings({});
  try {
    saveSettings({
      telegramRichTranscriptEntryEffect: 'draft',
      telegramRichTranscriptEntryEffectDelayMs: 0,
      telegramRichTranscriptEntryEffectText: 'Формируем карточку…'
    });
    const id = 'rich-entry-effect-ticket-0000-0000000000';
    db.createTicket.run(id, 'Эффект', 'session-rich-entry-effect');
    db.assignTicket.run('7001', id);
    db.saveTelegramThread.run(id, '7001', '7001', 923, null);
    db.saveMessage.run('rich-entry-effect-message', id, 'user', 'Эффект', 'Плавное появление', 'text', null, null, null, null, null);

    const before = richDrafts.length;
    await telegram.refreshOpenTicketTranscripts();
    const drafts = richDrafts.slice(before).filter(item => item.options?.message_thread_id === 923);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[0].markdown, '<tg-thinking>Формируем карточку…</tg-thinking>');
    assert.match(drafts[1].markdown, /Плавное появление/);
    assert.ok(rich.findLast(item => item.options?.message_thread_id === 923));
  } finally {
    saveSettings(previous);
  }
});

test('a transient Telegram fetch error alerts only after repeated failures', async () => {
  const alertsBefore = sent.filter(item => item.text.includes('Контроль доставки чата')).length;
  const error = new Error('EFATAL: fetch failed');
  fakeBot.handlers.polling_error(error);
  fakeBot.handlers.polling_error(error);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(
    sent.filter(item => item.text.includes('Контроль доставки чата')).length,
    alertsBefore
  );

  fakeBot.handlers.polling_error(error);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(
    sent.filter(item => item.text.includes('Контроль доставки чата')).length,
    alertsBefore + 1
  );
});

test('customer replies use stable sendMessage and remain queued after a transport failure', async () => {
  const ticketId = 'customer-delivery-retry-0000-0000';
  const messageId = 'customer-delivery-retry-message';
  db.createTicket.run(ticketId, 'Клиент доставки', 'session-customer-delivery-retry');
  db.db.prepare(`
    UPDATE tickets
    SET source = 'telegram', telegram_customer_id = '8099', telegram_customer_chat_id = '8099'
    WHERE id = ?
  `).run(ticketId);
  db.saveMessage.run(
    messageId,
    ticketId,
    'support',
    'Оператор',
    'Надёжный ответ клиенту',
    'text',
    null,
    null,
    null,
    null,
    null
  );
  const ticket = db.getTicketById.get(ticketId);

  sendMessageFailuresRemaining = 1;
  await assert.rejects(
    telegram.deliverCustomerReply(ticket, db.getMessageById.get(messageId)),
    /fetch failed/
  );
  assert.equal(db.getMessageById.get(messageId).telegram_customer_message_id, null);
  db.db.prepare(`
    UPDATE messages SET telegram_customer_next_retry_at = datetime('now', '-1 second') WHERE id = ?
  `).run(messageId);

  let delivered = db.getMessageById.get(messageId);
  for (let attempt = 0; attempt < 120 && !delivered.telegram_customer_message_id; attempt++) {
    await telegram.processDeliveryQueue();
    await new Promise(resolve => setTimeout(resolve, 25));
    delivered = db.getMessageById.get(messageId);
  }
  assert.ok(delivered.telegram_customer_message_id);
  assert.ok(sent.some(item =>
    item.chatId === '8099' && item.text.includes('Надёжный ответ клиенту')
  ));
});

test('an incoming command retries a transient Telegram transport failure', async () => {
  db.clearTelegramOperatorDashboard.run('7001');
  richMessageFailuresRemaining = 1;

  await fakeBot.handlers.message({
    message_id: 9901,
    chat: { id: 7001, type: 'private' },
    from: { id: 7001, first_name: 'Оператор' },
    text: '/queue'
  });

  assert.equal(richMessageFailuresRemaining, 0);
  assert.ok(db.getTelegramOperatorDashboard.get('7001'));
});

test('a getUpdates conflict keeps polling available without sending a Telegram alert', async () => {
  const telegramAlertsBefore = sent.filter(item => item.text.includes('Контроль доставки чата')).length;
  const stopsBefore = stopPollingCalls;
  fakeBot.handlers.polling_error({
    response: {
      status: 409,
      body: {
        description: 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'
      }
    }
  });
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(stopPollingCalls, stopsBefore);
  assert.equal(
    sent.filter(item => item.text.includes('Контроль доставки чата')).length,
    telegramAlertsBefore
  );
  assert.equal(telegram.status().polling.owner, true);
  assert.equal(telegram.status().polling.conflicts, 1);
});

test('expired and permanently forbidden deletions stop while new cleanup still proceeds', async () => {
  const id = 'cleanup-terminal-ticket';
  db.createTicket.run(id, 'Cleanup test', 'cleanup-terminal-session');
  db.enqueueTelegramCustomerCleanup.run('7001', 99991, id, 'retry');
  db.enqueueTelegramCustomerCleanup.run('7001', 99992, id, 'retry');
  db.enqueueTelegramCustomerCleanup.run('7001', 99993, id, 'retry');
  db.db.prepare("UPDATE telegram_customer_cleanup_queue SET created_at = datetime('now', '-49 hours') WHERE message_id = 99991").run();
  const originalDelete = fakeBot.deleteMessage;
  let forbiddenAttempts = 0;
  fakeBot.deleteMessage = function(chatId, messageId) {
    if (Number(messageId) === 99992) { forbiddenAttempts++; return Promise.reject(new Error("Bad Request: message can't be deleted for everyone")); }
    return originalDelete.call(this, chatId, messageId);
  };
  try {
    await telegram.processDeliveryQueue();
    await telegram.processDeliveryQueue();
    assert.equal(deleted.some(x => x.messageId === 99991), false);
    assert.equal(forbiddenAttempts, 1);
    assert.equal(deleted.some(x => x.messageId === 99993), true);
    const pending = db.getPendingTelegramCustomerCleanup.all(100);
    assert.equal(pending.some(x => [99991, 99992, 99993].includes(x.message_id)), false);
    assert.match(db.db.prepare('SELECT last_error FROM telegram_customer_cleanup_queue WHERE message_id = 99991').get().last_error, /48 hours/);
  } finally { fakeBot.deleteMessage = originalDelete; }
});

test('invalid Telegram topic IDs clear only the stale thread association', async () => {
  const id = 'missing-topic-code-ticket';
  db.createTicket.run(id, 'Missing topic', 'missing-topic-code-session');
  db.assignTicket.run('7001', id);
  db.saveTelegramThread.run(id, '7001', '7001', 98981, null);
  const original = fakeBot.sendChatAction;
  fakeBot.sendChatAction = () => Promise.reject(new Error('Bad Request: TOPIC_ID_INVALID'));
  try {
    assert.equal(await telegram.checkTopicAlive(db.getTicketById.get(id)), true);
    assert.equal(db.getTelegramThreadForTicket.get(id), undefined);
    assert.equal(db.getTicketById.get(id).status, 'open');
  } finally { fakeBot.sendChatAction = original; }
});

test('operator cleanup requires confirmation and preserves the canonical dashboard', async () => {
  await fakeBot.handlers.message({message_id:98001,date:Math.floor(Date.now()/1000),chat:{id:7001,type:'private'},from:{id:7001,first_name:'Admin'},text:'/admin'});
  const panel=db.getTelegramOperatorDashboard.get('7001');
  const query={id:'cleanup-test',from:{id:7001,first_name:'Admin'},message:{message_id:panel.dashboard_message_id,chat:{id:7001,type:'private'}}};
  const before=deleted.length;
  await fakeBot.handlers.callback_query({...query,data:'dashboard:clear-confirm'});
  assert.equal(deleted.length,before);
  await fakeBot.handlers.callback_query({...query,data:'dashboard:clear'});
  assert.equal(deleted.length,before);
  assert.ok(JSON.stringify(edits.at(-1)).includes('48'));
  await fakeBot.handlers.callback_query({...query,data:'dashboard:clear-confirm'});
  assert.ok(!deleted.slice(before).some(row=>row.chatId==='7001'&&row.messageId===panel.dashboard_message_id));
  assert.equal(db.getTelegramOperatorDashboard.get('7001').dashboard_message_id,panel.dashboard_message_id);
  const after=deleted.length;
  await fakeBot.handlers.callback_query({...query,from:{id:999999},data:'dashboard:clear-confirm'});
  assert.equal(deleted.length,after);
});
