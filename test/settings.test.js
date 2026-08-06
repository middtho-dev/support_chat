const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-settings-test-'));
process.env.DB_PATH = path.join(root, 'support.db');

const db = require('../src/database');
const { loadSettings, saveSettings } = require('../src/settings');

test.after(() => {
  if (db.db.open) db.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('maintenance and alert settings persist and are normalized', () => {
  const saved = saveSettings({
    backupEnabled: false,
    backupIntervalHours: 3,
    backupRetention: 12.8,
    backupUploadsEnabled: false,
    uploadCleanupEnabled: false,
    uploadCleanupIntervalHours: 2,
    uploadOrphanGraceHours: 48,
    diskMonitoringEnabled: false,
    diskWarnPercent: 82,
    diskCriticalPercent: 82,
    operationalAlertsEnabled: false,
    operationalAlertCooldownMinutes: 30,
    telegramAutoAssignSingleOperator: false,
    telegramCustomerEnabled: true,
    telegramCustomerFilesEnabled: false,
    telegramCustomerDeliverReplies: true,
    telegramCustomerWelcomeText: '  Напишите нам в Telegram  ',
    telegramCustomerNewTicketText: 'Тикет создан',
    telegramCustomerClosedText: 'Тикет закрыт',
    telegramCustomerClosePromptText: '  Если вопрос решён, закройте обращение  ',
    telegramCustomerCloseButtonText: 'Закрыть',
    telegramCustomerNewButtonText: 'Новый тикет',
    telegramCustomerSendCloseButtonText: 'Отправить закрытие',
    telegramRichTranscriptTitle: '  История {name}  ',
    telegramRichTranscriptSubtitle: '  Тикет {shortId}: {status}  ',
    telegramRichTranscriptMaxMessages: 99,
    telegramRichTranscriptMessageMaxChars: 40,
    telegramRichTranscriptShowAuthor: false,
    telegramRichTranscriptShowTime: false,
    telegramRichTranscriptSeparator: 'dots',
    telegramRichTranscriptShowHeader: false,
    telegramRichTranscriptShowSubtitle: false,
    telegramRichTranscriptTitleSize: 'large',
    telegramRichTranscriptTitleStyle: 'italic',
    telegramRichTranscriptSubtitleStyle: 'code',
    telegramRichTranscriptMessageLayout: 'quote',
    telegramRichTranscriptMessageSize: 'large',
    telegramRichTranscriptMessageHeaderStyle: 'plain',
    telegramRichTranscriptTimestampFormat: 'date_time',
    telegramRichTranscriptAuthorMode: 'grouped',
    telegramRichTranscriptGroupWindowMinutes: 900,
    telegramRichTranscriptGroupContinuation: 'none',
    telegramRichTranscriptGroupSpacing: 'inherit',
    telegramRichTranscriptDensity: 'airy',
    telegramRichTranscriptOrder: 'newest_first',
    telegramRichTranscriptUserLabel: 'Клиент: {name}',
    telegramRichTranscriptOperatorLabel: 'Оператор: {name}',
    telegramRichTranscriptShowMediaLabel: false,
    telegramRichTranscriptShowOmittedNotice: false,
    telegramRichTranscriptFooter: 'Показано {shown}',
    telegramRichTranscriptEmptyText: 'Пусто'
  });

  assert.equal(saved.backupEnabled, false);
  assert.equal(saved.backupIntervalHours, 3);
  assert.equal(saved.backupRetention, 13);
  assert.equal(saved.backupUploadsEnabled, false);
  assert.equal(saved.uploadCleanupEnabled, false);
  assert.equal(saved.uploadCleanupIntervalHours, 2);
  assert.equal(saved.uploadOrphanGraceHours, 48);
  assert.equal(saved.diskMonitoringEnabled, false);
  assert.equal(saved.diskWarnPercent, 82);
  assert.equal(saved.diskCriticalPercent, 83);
  assert.equal(saved.operationalAlertsEnabled, false);
  assert.equal(saved.operationalAlertCooldownMinutes, 30);
  assert.equal(saved.telegramAutoAssignSingleOperator, false);
  assert.equal(saved.telegramCustomerEnabled, true);
  assert.equal(saved.telegramCustomerFilesEnabled, false);
  assert.equal(saved.telegramCustomerDeliverReplies, true);
  assert.equal('telegramCustomerReopenClosed' in saved, false);
  assert.equal('telegramCustomerReopenedText' in saved, false);
  assert.equal(saved.telegramCustomerWelcomeText, 'Напишите нам в Telegram');
  assert.equal(saved.telegramRichTranscriptTitle, 'История {name}');
  assert.equal(saved.telegramRichTranscriptSubtitle, 'Тикет {shortId}: {status}');
  assert.equal(saved.telegramRichTranscriptMaxMessages, 30);
  assert.equal(saved.telegramRichTranscriptMessageMaxChars, 80);
  assert.equal(saved.telegramRichTranscriptShowAuthor, false);
  assert.equal(saved.telegramRichTranscriptShowTime, false);
  assert.equal(saved.telegramRichTranscriptSeparator, 'dots');
  assert.equal(saved.telegramRichTranscriptShowHeader, false);
  assert.equal(saved.telegramRichTranscriptShowSubtitle, false);
  assert.equal(saved.telegramRichTranscriptTitleSize, 'large');
  assert.equal(saved.telegramRichTranscriptMessageLayout, 'quote');
  assert.equal(saved.telegramRichTranscriptMessageSize, 'large');
  assert.equal(saved.telegramRichTranscriptTimestampFormat, 'date_time');
  assert.equal(saved.telegramRichTranscriptAuthorMode, 'grouped');
  assert.equal(saved.telegramRichTranscriptGroupWindowMinutes, 120);
  assert.equal(saved.telegramRichTranscriptGroupContinuation, 'none');
  assert.equal(saved.telegramRichTranscriptGroupSpacing, 'inherit');
  assert.equal(saved.telegramRichTranscriptOrder, 'newest_first');
  assert.equal(saved.telegramRichTranscriptUserLabel, 'Клиент: {name}');
  assert.equal(saved.telegramRichTranscriptFooter, 'Показано {shown}');

  const loaded = loadSettings();
  assert.equal(loaded.backupEnabled, false);
  assert.equal(loaded.backupRetention, 13);
  assert.equal(loaded.diskCriticalPercent, 83);
  assert.equal(loaded.operationalAlertsEnabled, false);
  assert.equal(loaded.operationalAlertCooldownMinutes, 30);
  assert.equal(loaded.telegramAutoAssignSingleOperator, false);
  assert.equal(loaded.telegramCustomerFilesEnabled, false);
  assert.equal('telegramCustomerReopenClosed' in loaded, false);
  assert.equal('telegramCustomerReopenedText' in loaded, false);
  assert.equal(loaded.telegramCustomerClosedText, 'Тикет закрыт');
  assert.equal(loaded.telegramCustomerClosePromptText, 'Если вопрос решён, закройте обращение');
  assert.equal(loaded.telegramCustomerCloseButtonText, 'Закрыть');
  assert.equal(loaded.telegramCustomerNewButtonText, 'Новый тикет');
  assert.equal(loaded.telegramCustomerSendCloseButtonText, 'Отправить закрытие');
  assert.equal(loaded.telegramRichTranscriptTitle, 'История {name}');
  assert.equal(loaded.telegramRichTranscriptMaxMessages, 30);
  assert.equal(loaded.telegramRichTranscriptMessageMaxChars, 80);
  assert.equal(loaded.telegramRichTranscriptSeparator, 'dots');
  assert.equal(loaded.telegramRichTranscriptMessageLayout, 'quote');
  assert.equal(loaded.telegramRichTranscriptOrder, 'newest_first');
  assert.equal(loaded.telegramRichTranscriptAuthorMode, 'grouped');
  assert.equal(loaded.telegramRichTranscriptGroupWindowMinutes, 120);
  assert.equal(loaded.telegramRichTranscriptGroupContinuation, 'none');
  assert.equal(loaded.telegramRichTranscriptGroupSpacing, 'inherit');
  assert.equal(loaded.telegramRichTranscriptEmptyText, 'Пусто');
});

test('legacy Telegram ticket confirmation is upgraded to the pinned card template', () => {
  const saved = saveSettings({
    telegramCustomerNewTicketText: '✅ Обращение создано. Оператор уже получил уведомление.'
  });
  assert.doesNotMatch(saved.telegramCustomerNewTicketText, /обращени/i);
  assert.match(saved.telegramCustomerNewTicketText, /оператор/i);
});

test('legacy Rich client label is upgraded to the customer name placeholder', () => {
  const saved = saveSettings({ telegramRichTranscriptUserLabel: '👤 Клиент' });
  assert.equal(saved.telegramRichTranscriptUserLabel, '👤 {name}');
});

test('Rich entry effect settings are bounded and have a safe fallback', () => {
  const saved = saveSettings({
    telegramRichTranscriptEntryEffect: 'unsupported',
    telegramRichTranscriptEntryEffectDelayMs: 9000,
    telegramRichTranscriptEntryEffectText: '  Появление  '
  });
  assert.equal(saved.telegramRichTranscriptEntryEffect, 'off');
  assert.equal(saved.telegramRichTranscriptEntryEffectDelayMs, 1200);
  assert.equal(saved.telegramRichTranscriptEntryEffectText, 'Появление');
});

test('failed Telegram chat cleanup remains queued for retry', () => {
  const ticketId = 'cleanup-queue-ticket';
  db.createTicket.run(ticketId, 'Очистка', 'cleanup-queue-session');
  db.enqueueTelegramCustomerCleanup.run('9901', 42, ticketId, 'temporary Telegram error');

  const queued = db.getPendingTelegramCustomerCleanup.all(10);
  assert.ok(queued.some(item => item.chat_id === '9901' && item.message_id === 42));

  db.markTelegramCustomerCleanupAttempt.run('temporary Telegram error', '+15 seconds', '9901', 42);
  const retried = db.db.prepare('SELECT * FROM telegram_customer_cleanup_queue WHERE chat_id = ? AND message_id = ?').get('9901', 42);
  assert.equal(retried.attempts, 1);

  db.deleteTelegramCustomerCleanup.run('9901', 42);
});
