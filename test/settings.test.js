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
    telegramCustomerReopenClosed: false,
    telegramCustomerWelcomeText: '  Напишите нам в Telegram  ',
    telegramCustomerNewTicketText: 'Тикет создан',
    telegramCustomerReopenedText: 'Тикет снова открыт',
    telegramCustomerClosedText: 'Тикет закрыт'
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
  assert.equal(saved.telegramCustomerReopenClosed, false);
  assert.equal(saved.telegramCustomerWelcomeText, 'Напишите нам в Telegram');

  const loaded = loadSettings();
  assert.equal(loaded.backupEnabled, false);
  assert.equal(loaded.backupRetention, 13);
  assert.equal(loaded.diskCriticalPercent, 83);
  assert.equal(loaded.operationalAlertsEnabled, false);
  assert.equal(loaded.operationalAlertCooldownMinutes, 30);
  assert.equal(loaded.telegramAutoAssignSingleOperator, false);
  assert.equal(loaded.telegramCustomerFilesEnabled, false);
  assert.equal(loaded.telegramCustomerReopenClosed, false);
  assert.equal(loaded.telegramCustomerClosedText, 'Тикет закрыт');
});
