const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function safeUploadName(fileUrl) {
  if (!String(fileUrl || '').startsWith('/uploads/')) return null;
  try {
    const name = decodeURIComponent(String(fileUrl).slice('/uploads/'.length));
    return name && path.basename(name) === name && !name.includes('\0') ? name : null;
  } catch {
    return null;
  }
}

async function listFiles(directory) {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile()).map(entry => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function directoryStats(directory) {
  const names = await listFiles(directory);
  let bytes = 0;
  let newestAt = null;
  for (const name of names) {
    try {
      const stat = await fs.promises.stat(path.join(directory, name));
      bytes += stat.size;
      if (!newestAt || stat.mtimeMs > newestAt) newestAt = stat.mtimeMs;
    } catch {}
  }
  return { files: names.length, bytes, newestAt: newestAt ? new Date(newestAt).toISOString() : null };
}

function diskStats(directory) {
  try {
    const stat = fs.statfsSync(directory, { bigint: true });
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    const used = total - free;
    return {
      totalBytes: Number(total),
      freeBytes: Number(free),
      usedBytes: Number(used),
      usedPercent: total > 0n ? Number((used * 10000n) / total) / 100 : 0
    };
  } catch {
    return null;
  }
}

function createMaintenance({
  database,
  uploadsDir,
  backupDir = process.env.BACKUP_DIR || path.join(path.dirname(database.db.name), 'backups'),
  notify = async () => {},
  io = null,
  getSettings = () => ({})
}) {
  function currentConfig() {
    const settings = getSettings() || {};
    return {
      backupEnabled: settings.backupEnabled !== false,
      backupIntervalHours: Number(settings.backupIntervalHours || 24),
      backupRetention: Number(settings.backupRetention || 7),
      backupUploadsEnabled: settings.backupUploadsEnabled !== false,
      uploadCleanupEnabled: settings.uploadCleanupEnabled !== false,
      uploadCleanupIntervalHours: Number(settings.uploadCleanupIntervalHours || 6),
      uploadOrphanGraceHours: Number(settings.uploadOrphanGraceHours || 24),
      diskMonitoringEnabled: settings.diskMonitoringEnabled !== false,
      diskWarnPercent: Number(settings.diskWarnPercent || 75),
      diskCriticalPercent: Number(settings.diskCriticalPercent || 90)
    };
  }

  const dbBackupDir = path.join(backupDir, 'database');
  const uploadMirrorDir = path.join(backupDir, 'uploads');
  const manifestPath = path.join(backupDir, 'maintenance.json');
  const startedAt = Date.now();
  let backupPromise = null;
  let cleanupPromise = null;
  const timers = [];
  const state = {
    backupDir,
    lastBackupAt: null,
    lastBackupFile: null,
    lastBackupBytes: 0,
    lastBackupError: null,
    lastBackupDurationMs: null,
    mirroredUploadFiles: 0,
    lastCleanupAt: null,
    lastCleanupRemoved: 0,
    lastCleanupFreedBytes: 0,
    lastCleanupError: null,
    uploads: { files: 0, bytes: 0, newestAt: null },
    disk: null,
    backupInProgress: false,
    cleanupInProgress: false
  };

  function publicStatus() {
    const config = currentConfig();
    const lastBackupMs = state.lastBackupAt ? Date.parse(state.lastBackupAt) : 0;
    const overdueMs = config.backupIntervalHours * 60 * 60 * 1000 * 1.5;
    const backupOverdue = config.backupEnabled &&
      Date.now() - (lastBackupMs || startedAt) > overdueMs;
    const diskLevel = !state.disk
      ? 'unknown'
      : state.disk.usedPercent >= config.diskCriticalPercent
        ? 'critical'
        : state.disk.usedPercent >= config.diskWarnPercent
          ? 'warning'
          : 'ok';
    return {
      ...state,
      config,
      backupOverdue,
      diskLevel,
      healthy: (!config.diskMonitoringEnabled || diskLevel !== 'critical') &&
        (!config.backupEnabled || (!state.lastBackupError && !backupOverdue))
    };
  }

  async function writeManifest() {
    await fs.promises.mkdir(backupDir, { recursive: true });
    const temp = `${manifestPath}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      state: publicStatus()
    }, null, 2));
    await fs.promises.rename(temp, manifestPath);
  }

  async function loadManifest() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      const saved = parsed?.state || {};
      for (const key of [
        'lastBackupAt', 'lastBackupFile', 'lastBackupBytes', 'lastBackupError',
        'lastBackupDurationMs', 'mirroredUploadFiles', 'lastCleanupAt',
        'lastCleanupRemoved', 'lastCleanupFreedBytes', 'lastCleanupError'
      ]) {
        if (saved[key] !== undefined) state[key] = saved[key];
      }
    } catch {}
  }

  async function syncUploads() {
    await fs.promises.mkdir(uploadMirrorDir, { recursive: true });
    const names = await listFiles(uploadsDir);
    let copied = 0;
    for (const name of names) {
      const source = path.join(uploadsDir, name);
      const destination = path.join(uploadMirrorDir, name);
      let needsCopy = true;
      try {
        const [sourceStat, destinationStat] = await Promise.all([
          fs.promises.stat(source),
          fs.promises.stat(destination)
        ]);
        needsCopy = sourceStat.size !== destinationStat.size ||
          sourceStat.mtimeMs > destinationStat.mtimeMs + 1000;
      } catch {}
      if (!needsCopy) continue;
      const temp = `${destination}.tmp`;
      await fs.promises.copyFile(source, temp);
      await fs.promises.rename(temp, destination);
      copied++;
    }
    state.mirroredUploadFiles = names.length;
    return { total: names.length, copied };
  }

  async function rotateDatabaseBackups() {
    const config = currentConfig();
    const files = (await listFiles(dbBackupDir))
      .filter(name => /^support-\d{4}-\d{2}-\d{2}T.*\.db$/.test(name))
      .sort()
      .reverse();
    const expired = files.slice(config.backupRetention);
    await Promise.all(expired.map(name => fs.promises.unlink(path.join(dbBackupDir, name)).catch(() => {})));
    return expired.length;
  }

  async function performBackup(reason = 'scheduled') {
    const startedAt = Date.now();
    state.backupInProgress = true;
    state.lastBackupError = null;
    await fs.promises.mkdir(dbBackupDir, { recursive: true });
    await fs.promises.mkdir(uploadMirrorDir, { recursive: true });
    const fileName = `support-${isoStamp()}.db`;
    const finalPath = path.join(dbBackupDir, fileName);
    const tempPath = `${finalPath}.tmp`;
    try {
      await fs.promises.unlink(tempPath).catch(() => {});
      await database.db.backup(tempPath);
      const checkDb = new Database(tempPath, { readonly: true, fileMustExist: true });
      try {
        const result = checkDb.pragma('quick_check', { simple: true });
        if (result !== 'ok') throw new Error(`SQLite quick_check: ${result}`);
      } finally {
        checkDb.close();
      }
      await fs.promises.rename(tempPath, finalPath);
      const config = currentConfig();
      const [backupStat, mirror] = await Promise.all([
        fs.promises.stat(finalPath),
        config.backupUploadsEnabled
          ? syncUploads()
          : Promise.resolve({ total: state.mirroredUploadFiles, copied: 0, disabled: true })
      ]);
      await rotateDatabaseBackups();
      state.lastBackupAt = new Date().toISOString();
      state.lastBackupFile = fileName;
      state.lastBackupBytes = backupStat.size;
      state.lastBackupDurationMs = Date.now() - startedAt;
      state.lastBackupError = null;
      await refreshStatus({ alertDisk: false });
      await writeManifest();
      io?.to('admin').emit('maintenance_updated', publicStatus());
      return {
        ok: true,
        reason,
        file: fileName,
        bytes: backupStat.size,
        durationMs: state.lastBackupDurationMs,
        uploads: mirror
      };
    } catch (error) {
      await fs.promises.unlink(tempPath).catch(() => {});
      state.lastBackupError = String(error?.message || error);
      state.lastBackupDurationMs = Date.now() - startedAt;
      await writeManifest().catch(() => {});
      await notify('maintenance-backup-failed', 'Не удалось создать резервную копию', state.lastBackupError);
      io?.to('admin').emit('maintenance_updated', publicStatus());
      throw error;
    } finally {
      state.backupInProgress = false;
    }
  }

  function runBackup(reason = 'manual') {
    if (!backupPromise) {
      backupPromise = performBackup(reason).finally(() => {
        backupPromise = null;
      });
    }
    return backupPromise;
  }

  async function performCleanup(reason = 'scheduled') {
    const config = currentConfig();
    state.cleanupInProgress = true;
    state.lastCleanupError = null;
    try {
      const referenced = new Set(database.db.prepare(`
        SELECT DISTINCT file_url
        FROM messages
        WHERE file_url LIKE '/uploads/%'
      `).all().map(row => safeUploadName(row.file_url)).filter(Boolean));
      const names = await listFiles(uploadsDir);
      const cutoff = Date.now() - config.uploadOrphanGraceHours * 60 * 60 * 1000;
      let removed = 0;
      let freedBytes = 0;
      for (const name of names) {
        if (referenced.has(name)) continue;
        const filePath = path.join(uploadsDir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.mtimeMs > cutoff) continue;
          await fs.promises.unlink(filePath);
          removed++;
          freedBytes += stat.size;
        } catch {}
      }
      state.lastCleanupAt = new Date().toISOString();
      state.lastCleanupRemoved = removed;
      state.lastCleanupFreedBytes = freedBytes;
      await refreshStatus({ alertDisk: true });
      await writeManifest();
      io?.to('admin').emit('maintenance_updated', publicStatus());
      return { ok: true, reason, removed, freedBytes };
    } catch (error) {
      state.lastCleanupError = String(error?.message || error);
      await writeManifest().catch(() => {});
      await notify('maintenance-cleanup-failed', 'Ошибка очистки загруженных файлов', state.lastCleanupError);
      throw error;
    } finally {
      state.cleanupInProgress = false;
    }
  }

  function runCleanup(reason = 'manual') {
    if (!cleanupPromise) {
      cleanupPromise = performCleanup(reason).finally(() => {
        cleanupPromise = null;
      });
    }
    return cleanupPromise;
  }

  async function refreshStatus({ alertDisk = true } = {}) {
    const config = currentConfig();
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    state.uploads = await directoryStats(uploadsDir);
    state.disk = diskStats(uploadsDir);
    if (config.diskMonitoringEnabled && alertDisk && state.disk?.usedPercent >= config.diskCriticalPercent) {
      await notify(
        'maintenance-disk-critical',
        `Диск заполнен на ${state.disk.usedPercent}%`,
        `Свободно ${state.disk.freeBytes} байт. Загрузки: ${state.uploads.files} файлов.`
      );
    } else if (config.diskMonitoringEnabled && alertDisk && state.disk?.usedPercent >= config.diskWarnPercent) {
      await notify(
        'maintenance-disk-warning',
        `Диск заполнен на ${state.disk.usedPercent}%`,
        'Проверьте резервные копии и загруженные файлы.'
      );
    }
    return publicStatus();
  }

  async function init() {
    await fs.promises.mkdir(backupDir, { recursive: true });
    await loadManifest();
    await refreshStatus({ alertDisk: true });
    const schedulerTick = async () => {
      const config = currentConfig();
      const now = Date.now();
      const backupDue = !state.lastBackupAt ||
        now - Date.parse(state.lastBackupAt) >= config.backupIntervalHours * 60 * 60 * 1000;
      const cleanupDue = !state.lastCleanupAt ||
        now - Date.parse(state.lastCleanupAt) >= config.uploadCleanupIntervalHours * 60 * 60 * 1000;
      if (config.backupEnabled && backupDue) await runBackup('scheduled').catch(() => {});
      if (config.uploadCleanupEnabled && cleanupDue) await runCleanup('scheduled').catch(() => {});
      await refreshStatus({ alertDisk: true }).catch(() => {});
    };
    timers.push(setTimeout(schedulerTick, 30000));
    timers.push(setInterval(schedulerTick, 60000));
    timers.forEach(timer => timer.unref?.());
    return publicStatus();
  }

  function shutdown() {
    timers.splice(0).forEach(timer => {
      clearTimeout(timer);
      clearInterval(timer);
    });
  }

  return {
    init,
    shutdown,
    status: publicStatus,
    refreshStatus,
    runBackup,
    runCleanup,
    config: currentConfig
  };
}

module.exports = { createMaintenance, safeUploadName };
