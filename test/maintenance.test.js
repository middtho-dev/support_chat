const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createMaintenance } = require('../src/maintenance');

test('backup is verified and orphan cleanup preserves referenced uploads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-maintenance-'));
  const uploadsDir = path.join(root, 'uploads');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const sqlite = new Database(path.join(root, 'support.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, file_url TEXT);
    CREATE TABLE marker (value TEXT);
    INSERT INTO marker (value) VALUES ('recoverable');
  `);
  sqlite.prepare('INSERT INTO messages (id, file_url) VALUES (?, ?)').run('m1', '/uploads/kept.jpg');
  fs.writeFileSync(path.join(uploadsDir, 'kept.jpg'), 'kept');
  fs.writeFileSync(path.join(uploadsDir, 'orphan.jpg'), 'orphan');
  const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
  fs.utimesSync(path.join(uploadsDir, 'orphan.jpg'), old, old);

  const settings = {
    backupEnabled: true,
    backupIntervalHours: 24,
    backupRetention: 2,
    backupUploadsEnabled: true,
    uploadCleanupEnabled: true,
    uploadCleanupIntervalHours: 6,
    uploadOrphanGraceHours: 1,
    diskMonitoringEnabled: true,
    diskWarnPercent: 98,
    diskCriticalPercent: 99
  };
  const maintenance = createMaintenance({
    database: { db: sqlite },
    uploadsDir,
    backupDir,
    getSettings: () => settings
  });
  t.after(() => {
    maintenance.shutdown();
    if (sqlite.open) sqlite.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  await maintenance.init();
  const backup = await maintenance.runBackup('test');
  assert.equal(backup.ok, true);
  assert.equal(backup.uploads.total, 2);
  assert.equal(fs.existsSync(path.join(backupDir, 'uploads', 'kept.jpg')), true);
  assert.equal(fs.existsSync(path.join(backupDir, 'uploads', 'orphan.jpg')), true);

  const backupDb = new Database(path.join(backupDir, 'database', backup.file), { readonly: true });
  assert.equal(backupDb.pragma('quick_check', { simple: true }), 'ok');
  assert.equal(backupDb.prepare('SELECT value FROM marker').get().value, 'recoverable');
  backupDb.close();

  const cleanup = await maintenance.runCleanup('test');
  assert.equal(cleanup.removed, 1);
  assert.equal(fs.existsSync(path.join(uploadsDir, 'kept.jpg')), true);
  assert.equal(fs.existsSync(path.join(uploadsDir, 'orphan.jpg')), false);
  assert.equal(maintenance.status().lastBackupError, null);
  assert.equal(maintenance.status().lastCleanupError, null);
});

test('runtime maintenance settings are applied without recreation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-maintenance-settings-'));
  const sqlite = new Database(path.join(root, 'support.db'));
  sqlite.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, file_url TEXT)');
  const settings = {
    backupEnabled: true,
    backupIntervalHours: 24,
    backupRetention: 7,
    backupUploadsEnabled: true,
    uploadCleanupEnabled: true,
    uploadCleanupIntervalHours: 6,
    uploadOrphanGraceHours: 24,
    diskMonitoringEnabled: true,
    diskWarnPercent: 75,
    diskCriticalPercent: 90
  };
  const maintenance = createMaintenance({
    database: { db: sqlite },
    uploadsDir: path.join(root, 'uploads'),
    backupDir: path.join(root, 'backups'),
    getSettings: () => settings
  });
  assert.equal(maintenance.status().config.backupIntervalHours, 24);
  settings.backupIntervalHours = 3;
  settings.backupEnabled = false;
  assert.equal(maintenance.status().config.backupIntervalHours, 3);
  assert.equal(maintenance.status().config.backupEnabled, false);
  maintenance.shutdown();
  sqlite.close();
  fs.rmSync(root, { recursive: true, force: true });
});
