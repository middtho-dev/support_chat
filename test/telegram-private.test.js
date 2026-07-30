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
let topicAttempts = 0;
let messageId = 10;

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
    sent.push({ chatId: String(chatId), text, options });
    return Promise.resolve({ message_id: ++messageId });
  }
  sendRichMessage(chatId, payload, options) {
    rich.push({ chatId: String(chatId), markdown: payload.markdown, options });
    return Promise.resolve({ message_id: ++messageId });
  }
  editMessageText() {
    return Promise.resolve({});
  }
  editMessageReplyMarkup() {
    return Promise.resolve({});
  }
  pinChatMessage() {
    return Promise.resolve();
  }
  createForumTopic() {
    topicAttempts++;
    return topicAttempts === 1
      ? Promise.reject(new Error('temporary Telegram error'))
      : Promise.resolve({ message_thread_id: 501 });
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
const telegram = require('../src/telegram-private');
telegram.init({ to: () => ({ emit: () => {} }) });

test.after(() => {
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
  assert.match(intro.markdown, /Оператор/);
  assert.match(intro.markdown, /Создан/);
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
  db.db.prepare("UPDATE tickets SET telegram_last_reminded_at=datetime('now','-10 minutes') WHERE id=?").run(id);
  assert.equal(await telegram.processUnansweredReminders(), 0);
});
