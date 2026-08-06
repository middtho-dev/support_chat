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
process.env.PUBLIC_URL = 'https://support.example';

const sent = [];
const rich = [];
const pins = [];
const unpins = [];
const edits = [];
const markupEdits = [];
const deleted = [];
const callbackAnswers = [];
const welcomeTickets = [];
const operatorWaits = [];
const socketEmits = [];
let topicAttempts = 0;
let nextTopicId = 500;
let messageId = 10;
let stopPollingCalls = 0;

class FakeBot {
  constructor() {
    this.handlers = {};
  }
  on(name, handler) {
    this.handlers[name] = handler;
  }
  startPolling() {
    return Promise.resolve();
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
  sendMessage(chatId, text, options) {
    const sentMessageId = ++messageId;
    sent.push({ chatId: String(chatId), text, options, messageId: sentMessageId });
    return Promise.resolve({ message_id: sentMessageId });
  }
  sendRichMessage(chatId, payload, options) {
    const sentMessageId = ++messageId;
    rich.push({
      chatId: String(chatId),
      markdown: payload.markdown,
      options,
      messageId: sentMessageId
    });
    return Promise.resolve({ message_id: sentMessageId });
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
    }
  }
);

test.after(async () => {
  await telegram.shutdown();
  if (db.db.open) db.db.close();
  fs.rmSync(root, { recursive: true, force: true });
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
  assert.match(transcript, /> \*\*👤 Клиент\*\* · _\d{2}:\d{2}_/);
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
  const supportDelivery = rich.find(item =>
    item.chatId === customerId && item.markdown.includes('Проверяем подключение')
  );
  assert.ok(supportDelivery);
  assert.equal(supportDelivery.options?.reply_markup, undefined);
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
