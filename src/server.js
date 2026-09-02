require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./database');
const telegram = require('./telegram');
const push = require('./push');
const { loadSettings, saveSettings } = require('./settings');
const { createMaintenance } = require('./maintenance');
const uuidv4 = () => crypto.randomUUID();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
  maxHttpBufferSize: 50 * 1024 * 1024,
  // Keep both transports available. Some CDNs allow WebSocket but interfere
  // with long-polling, while others do the opposite.
  transports: ['polling', 'websocket'],
  pingInterval: 25000,
  pingTimeout: 30000
});

// Prevent intermediary caches and response buffering from corrupting the
// Engine.IO polling handshake. WebSocket upgrades use the same endpoint.
io.engine.on('headers', headers => {
  headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
  headers.Pragma = 'no-cache';
  headers['X-Accel-Buffering'] = 'no';
});

telegram.init(io, {
  scheduleWelcomeMessages,
  scheduleOperatorWaitMessage,
  cancelOperatorWait
});
push.init();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const TELEGRAM_ADMIN_IDS = new Set(String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(v => v.trim()).filter(Boolean));
const miniAdminSessions = new Map();
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const maintenance = createMaintenance({
  database: db,
  uploadsDir: UPLOADS_DIR,
  notify: (...args) => telegram.notifyOperationalIssue?.(...args) || Promise.resolve(),
  io,
  getSettings: loadSettings
});
maintenance.init().catch(error => {
  console.error('[Maintenance] init:', error?.message || error);
});

const DISPLAY_IMAGE_EXTS = new Set(['.jpg','.jpeg','.jpe','.jfif','.png','.gif','.webp']);
const IMG_EXTS = new Set([
  ...DISPLAY_IMAGE_EXTS,
  '.heic','.heif','.heics','.heifs','.avif','.bmp','.tif','.tiff','.dng'
]);
const VID_EXTS = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);
const AUD_EXTS = new Set(['.mp3','.m4a','.aac','.ogg','.wav','.flac','.opus']);
const DOC_EXTS = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.zip','.7z','.rar','.txt','.csv']);
const IMAGE_MIMES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif',
  'image/heic-sequence','image/heif-sequence','image/avif','image/tiff','image/bmp',
  'image/x-heic','image/x-heif','image/x-canon-cr2','image/x-adobe-dng'
]);
const DISPLAY_IMAGE_MIMES = new Set(['image/jpeg','image/png','image/gif','image/webp']);
const ALLOWED_MIMES = new Set([
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-zip-compressed','application/x-zip','application/x-7z-compressed',
  'application/x-rar-compressed','application/vnd.rar','text/plain','text/csv',
  'image/heic','image/heif','image/avif','image/tiff','image/bmp'
]);

function normalizeMime(value) {
  const mime = String(value || '').toLowerCase().split(';', 1)[0].trim();
  const aliases = {
    'image/jpg': 'image/jpeg',
    'image/pjpeg': 'image/jpeg',
    'image/x-heic': 'image/heic',
    'image/heic-sequence': 'image/heic',
    'image/x-heif': 'image/heif',
    'image/heif-sequence': 'image/heif',
    'image/x-adobe-dng': 'image/tiff'
  };
  return aliases[mime] || mime;
}

function mimeFromExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  const byExt = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jpe': 'image/jpeg', '.jfif': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.heic': 'image/heic', '.heics': 'image/heic', '.heif': 'image/heif', '.heifs': 'image/heif',
    '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.dng': 'image/tiff',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.opus': 'audio/opus'
  };
  if (byExt[ext]) return byExt[ext];
  return null;
}

function detectImageMime(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(64);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    const bytes = head.subarray(0, read);
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'image/png';
    if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (bytes.length >= 4 &&
        (bytes.subarray(0, 4).equals(Buffer.from([0x49,0x49,0x2a,0x00])) ||
         bytes.subarray(0, 4).equals(Buffer.from([0x4d,0x4d,0x00,0x2a])))) return 'image/tiff';
    if (bytes.length >= 2 && bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
    if (bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brands = bytes.subarray(8).toString('ascii');
      if (/(^|.{4})(avif|avis)/.test(brands)) return 'image/avif';
      if (/(^|.{4})(heic|heix|hevc|hevx|heim|heis|hevm|hevs|heif|mif1|msf1)/.test(brands)) {
        return 'image/heic';
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function uploadMetadata(file) {
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  let mime = normalizeMime(file.mimetype);
  if (!mime || mime === 'application/octet-stream') mime = mimeFromExt(file.originalname) || mime || 'application/octet-stream';
  const detectedImageMime = detectImageMime(file.path);
  if (detectedImageMime) mime = detectedImageMime;

  let type = 'file';
  if (DISPLAY_IMAGE_MIMES.has(mime) && (DISPLAY_IMAGE_EXTS.has(ext) || !!detectedImageMime)) type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';

  return { name: file.originalname, mime, type };
}

function isSafeUploadUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return false;
  if (!fileUrl.startsWith('/uploads/')) return false;
  let relative;
  try {
    relative = decodeURIComponent(fileUrl.slice('/uploads/'.length));
  } catch {
    return false;
  }
  if (!relative || relative !== path.basename(relative) || relative.includes('\0')) return false;
  const uploadsDir = path.resolve(UPLOADS_DIR);
  const fp = path.resolve(uploadsDir, relative);
  return fp.startsWith(uploadsDir + path.sep);
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  if (ADMIN_TOKEN && safeEqualString(token, ADMIN_TOKEN)) return true;
  const session = getMiniAdminSession(token);
  return !!session;
}

function getMiniAdminSession(token) {
  if (!token || typeof token !== 'string') return null;
  const session = miniAdminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    miniAdminSessions.delete(token);
    return null;
  }
  return session;
}

function getOperatorAccess(userId) {
  const id = String(userId || '');
  if (!id) return { allowed: false, canManageSettings: false };
  if (TELEGRAM_ADMIN_IDS.has(id)) return { allowed: true, canManageSettings: true };
  const operator = db.getTelegramOperator.get(id);
  return {
    allowed: !!operator?.active,
    canManageSettings: !!operator?.active && !!operator?.can_manage_settings
  };
}

function socketCanManageSettings(socket) {
  if (!socket?.isAdmin) return false;
  if (socket.adminUsesToken) return true;
  return getOperatorAccess(socket.adminUserId).canManageSettings;
}

function emitToSettingsManagers(event, payload, excludedSocketId = '') {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.id !== excludedSocketId && socketCanManageSettings(socket)) socket.emit(event, payload);
  }
}

function normalizeManagedOperator(payload = {}) {
  const telegramUserId = String(payload.telegramUserId || '').trim();
  if (!/^\d{4,20}$/.test(telegramUserId)) return { error: 'Укажите корректный числовой Telegram ID' };
  const displayName = String(payload.displayName || '').trim().slice(0, 80);
  if (!displayName) return { error: 'Укажите имя оператора' };
  const username = String(payload.username || '').trim().replace(/^@/, '');
  if (username && !/^[a-zA-Z0-9_]{5,32}$/.test(username)) {
    return { error: 'Username Telegram указан неверно' };
  }
  return {
    telegramUserId,
    displayName,
    username: username || null,
    active: payload.active !== false,
    canManageSettings: !!payload.canManageSettings
  };
}

function cleanupMiniAdminSessions() {
  const now = Date.now();
  for (const [token, session] of miniAdminSessions) {
    if (session.expiresAt < now) miniAdminSessions.delete(token);
  }
}
setInterval(cleanupMiniAdminSessions, 10 * 60 * 1000);

function verifyTelegramInitData(initData) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const expected = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualString(hash, expected)) return null;
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 24 * 60 * 60) return null;
  try {
    const user = JSON.parse(params.get('user') || '{}');
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

function isAdminRequest(req) {
  return isAdminToken(req.body?.adminToken || req.query?.adminToken || req.get('x-admin-token'));
}

function usesLegacyTelegramTopics() {
  return typeof telegram.status === 'function' && telegram.status()?.mode !== 'private';
}

function canUpload(req) {
  if (isAdminRequest(req)) return true;
  const { ticketId, sessionToken } = req.body || {};
  if (!ticketId || !sessionToken) return false;
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  return !!ticket && ticket.id === ticketId && ticket.status === 'open';
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `${uuidv4()}${ext}`);
    }
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    let mime = String(file.mimetype || '').toLowerCase().split(';', 1)[0].trim();
    if (mime === 'application/octet-stream') mime = mimeFromExt(file.originalname) || mime;
    const ext = path.extname(file.originalname || '').toLowerCase();
    const normalizedMime = normalizeMime(mime);
    const ok =
      ((IMAGE_MIMES.has(mime) || IMAGE_MIMES.has(normalizedMime)) &&
        (IMG_EXTS.has(ext) || !ext)) ||
      (mime.startsWith('video/') && VID_EXTS.has(ext)) ||
      (mime.startsWith('audio/') && AUD_EXTS.has(ext)) ||
      (ALLOWED_MIMES.has(mime) && DOC_EXTS.has(ext));
    ok ? cb(null, true) : cb(new Error('UNSUPPORTED_FILE_TYPE'));
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/logo.png'));
});

app.get(['/miniapp', '/tg-admin'], (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  const params = new URLSearchParams({ tg: '1', v: Date.now().toString(36) });
  const ticketId = String(req.query?.ticket || '');
  if (/^[a-f0-9-]{16,64}$/i.test(ticketId)) params.set('ticket', ticketId);
  res.redirect(302, `/admin?${params.toString()}`);
});

app.get('/admin', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('<h1>Admin panel disabled</h1><p>Set ADMIN_TOKEN in .env to enable.</p>');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  const htmlPath = path.join(__dirname, '../public/admin.html');
  fs.readFile(htmlPath, 'utf8', (err, html) => {
    if (err) return res.sendFile(htmlPath);
    const v = Date.now().toString(36);
    res.type('html').send(html
      .replace('/css/admin.css', `/css/admin.css?v=${v}`)
      .replace('/js/admin-enhance.js', `/js/admin-enhance.js?v=${v}`)
      .replace('/js/admin.js', `/js/admin.js?v=${v}`));
  });
});
app.use('/uploads', express.static(UPLOADS_DIR, { index: false, maxAge: '1h' }));
app.use(express.static(path.join(__dirname, '../public')));

app.post('/api/admin/telegram-auth', (req, res) => {
  const user = verifyTelegramInitData(req.body?.initData);
  if (!user) return res.status(401).json({ error: 'Telegram auth failed' });
  const access = getOperatorAccess(user.id);
  if (!access.allowed) return res.status(403).json({ error: 'Access denied' });
  cleanupMiniAdminSessions();
  const token = uuidv4();
  miniAdminSessions.set(token, {
    userId: String(user.id),
    canManageSettings: access.canManageSettings,
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  });
  res.json({
    adminSessionToken: token,
    permissions: { canManageSettings: access.canManageSettings },
    user: { id: user.id, first_name: user.first_name || '', username: user.username || '' }
  });
});

app.get('/api/admin/maintenance', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await maintenance.refreshStatus({ alertDisk: false });
    res.json(maintenance.status());
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Maintenance status failed' });
  }
});

app.post('/api/admin/maintenance/backup', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await maintenance.runBackup('manual');
    res.json({ ...result, status: maintenance.status() });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Backup failed', status: maintenance.status() });
  }
});

app.post('/api/admin/maintenance/cleanup', async (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await maintenance.runCleanup('manual');
    res.json({ ...result, status: maintenance.status() });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Cleanup failed', status: maintenance.status() });
  }
});

function isWithinWorkHours(cfg = loadSettings()) {
  let hour;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: cfg.timezone }).format(new Date()));
  } catch {
    hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Moscow' }).format(new Date()));
  }
  return hour >= cfg.workStartHour && hour < cfg.workEndHour;
}

function publicConfig() {
  const cfg = loadSettings();
  return { settings: cfg, online: isWithinWorkHours(cfg) };
}

app.post('/api/session/start', (req, res) => {
  const cfg = loadSettings();
  const raw = req.body?.name;
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'Name required' });
  const name = raw.trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'Name required' });

  const sessionToken = uuidv4();
  const ticketId = uuidv4();
  db.createTicket.run(ticketId, name, sessionToken);
  telegram.createTopic(ticketId, name)
    .then(topicId => { if (topicId) broadcastAdminTickets(); })
    .catch(e => console.error('[TG] createTopic:', e?.message));

  const newTicket = db.getTicketById.get(ticketId);
  if (newTicket) io.to('admin').emit('admin_new_ticket', newTicket);
  res.json({ sessionToken, ticketId, userName: name });
});

app.post('/api/session/resume', (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken || typeof sessionToken !== 'string') return res.status(400).json({ error: 'Token required' });
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket) return res.status(404).json({ error: 'No active ticket' });
  if (usesLegacyTelegramTopics() && ticket.status === 'closed' && ticket.telegram_topic_deleted) {
    return res.json({ orphaned: true });
  }

  const PAGE = 100;
  const total = db.countMessages.get(ticket.id)?.cnt || 0;
  const messages = db.getMessagesRecent.all(ticket.id, PAGE);
  const cfg = loadSettings();
  res.json({ ticket, messages, hasMore: total > PAGE, settings: cfg, online: isWithinWorkHours(cfg) });
});

app.post('/api/session/messages-seen', (req, res) => {
  const { sessionToken, ticketId, messageIds } = req.body || {};
  if (!sessionToken || !ticketId) return res.status(400).json({ error: 'Missing params' });
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket || ticket.id !== ticketId) return res.status(403).json({ error: 'Forbidden' });
  res.json({ ok: true, delivered: confirmCustomerMessagesSeen(ticket, messageIds) });
});
app.post('/api/session/message', (req, res) => {
  try {
    const result = acceptCustomerMessage(req.body);
    res.status(result.status || 200).json(result);
  } catch (error) {
    console.error('[HTTP] customer message:', error);
    res.status(500).json({ error: 'Server error' });
  }
});
app.get('/api/chat-config', (req, res) => res.json(publicConfig()));

app.get('/api/tickets/:ticketId/messages', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (!isAdminRequest(req) && (!req.query.sessionToken || ticket.session_token !== req.query.sessionToken)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.json(db.getMessages.all(ticket.id));
});

app.post('/api/tickets/:ticketId/messages/older', (req, res) => {
  const { sessionToken, before } = req.body;
  if (!sessionToken || !before) return res.status(400).json({ error: 'Missing params' });
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket || ticket.id !== req.params.ticketId) return res.status(403).json({ error: 'Forbidden' });
  const LIMIT = 50;
  const messages = db.getMessagesBefore.all(ticket.id, before, LIMIT);
  res.json({ messages, hasMore: messages.length === LIMIT });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  if (!canUpload(req)) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Forbidden' });
  }
  const cfg = loadSettings();
  if (req.file.size > cfg.uploadMaxMb * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    telegram.notifyOperationalIssue(
      'upload-too-large',
      'Клиенту не удалось загрузить файл',
      `Размер превышает ${cfg.uploadMaxMb} МБ`
    ).catch(() => {});
    return res.status(413).json({ error: `File too large. Max ${cfg.uploadMaxMb} MB` });
  }

  const meta = uploadMetadata(req.file);
  const claimedImage = IMAGE_MIMES.has(normalizeMime(req.file.mimetype)) ||
    IMG_EXTS.has(path.extname(req.file.originalname || '').toLowerCase());
  if (claimedImage && !detectImageMime(req.file.path)) {
    fs.unlink(req.file.path, () => {});
    telegram.notifyOperationalIssue(
      'upload-invalid-image',
      'Клиенту не удалось загрузить фото',
      `Формат файла ${req.file.originalname || 'без имени'} не удалось распознать`
    ).catch(() => {});
    return res.status(400).json({ error: 'Не удалось распознать формат изображения' });
  }
  res.json({ url: `/uploads/${req.file.filename}`, ...meta });
});

app.post('/api/tickets/:ticketId/close', (req, res) => {
  const { sessionToken } = req.body;
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!sessionToken || ticket.session_token !== sessionToken) return res.status(403).json({ error: 'Forbidden' });

  db.closeTicket.run(ticket.id);
  cancelOperatorWait(ticket.id);
  telegram.notifyTicketClosed(ticket, {
    customerReason: loadSettings().telegramCustomerClosedByUserText
  }).catch(e => console.error('[TG] notifyTicketClosed:', e?.message));
  io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'user' });
  io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  broadcastAdminTickets();
  res.json({ ok: true });
});

app.get('/api/push/vapid-key', (req, res) => {
  const key = push.getPublicKey();
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

app.post('/api/push/subscribe', (req, res) => {
  const { ticketId, sessionToken, subscription } = req.body;
  if (!subscription || !ticketId || !sessionToken) return res.status(400).json({ error: 'Missing params' });
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket || ticket.id !== ticketId) return res.status(403).json({ error: 'Forbidden' });
  db.savePushSub.run(uuidv4(), ticketId, JSON.stringify(subscription));
  res.json({ ok: true });
});

const welcomeSent = new Set();
const messageRates = new Map();
const warnedTickets = new Set();
const operatorWaitTimers = new Map();

function isRateLimited(sessionToken) {
  const cfg = loadSettings();
  const now = Date.now();
  let rate = messageRates.get(sessionToken);
  if (!rate || now > rate.resetAt) rate = { count: 0, resetAt: now + 60000 };
  rate.count++;
  messageRates.set(sessionToken, rate);
  if (rate.count > cfg.messageRateLimitPerMinute) {
    rate.retryAfter = Math.ceil((rate.resetAt - now) / 1000);
    return true;
  }
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, r] of messageRates) if (now > r.resetAt) messageRates.delete(k); }, 5 * 60 * 1000);

function emitSupportAutoMessage(ticketId, content) {
  const cfg = loadSettings();
  const ticket = db.getTicketById.get(ticketId);
  const text = String(content || '').trim();
  if (!ticket || ticket.status === 'closed' || !text) return null;
  const id = uuidv4();
  const created_at = new Date().toISOString();
  db.saveAutoMessage.run(id, ticketId, 'support', cfg.supportName, text, 'text', null, null, null, null, null);
  const message = {
    id, ticket_id: ticketId, sender: 'support', sender_name: cfg.supportName,
    content: text, message_type: 'text', file_url: null, file_name: null, file_mime: null, created_at
  };
  io.to(`ticket:${ticketId}`).emit('message', message);
  io.to('admin').emit('admin_new_message', { ticketId, message });
  broadcastAdminTickets();
  telegram.deliverCustomerReply?.(ticket, message).catch(error => {
    console.error('[Auto] Telegram customer delivery:', error?.message);
  });
  return message;
}

function cancelOperatorWait(ticketId) {
  const timer = operatorWaitTimers.get(ticketId);
  if (timer) clearTimeout(timer);
  operatorWaitTimers.delete(ticketId);
}

function scheduleOperatorWaitMessage(ticketId, afterMessageId) {
  cancelOperatorWait(ticketId);
  const cfg = loadSettings();
  if (!cfg.operatorWaitEnabled || !String(cfg.operatorWaitText || '').trim()) return;
  const timer = setTimeout(() => {
    operatorWaitTimers.delete(ticketId);
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;
    const messages = db.getMessages.all(ticketId);
    const userMsgIndex = messages.findIndex(message => message.id === afterMessageId);
    if (userMsgIndex < 0) return;
    const supportAnswered = messages.slice(userMsgIndex + 1).some(message => message.sender === 'support' && !message.is_auto);
    if (supportAnswered) return;
    emitSupportAutoMessage(ticketId, loadSettings().operatorWaitText);
  }, cfg.operatorWaitDelayMs);
  operatorWaitTimers.set(ticketId, timer);
}

function scheduleWelcomeMessages(ticketId) {
  const cfg = loadSettings();
  if (!cfg.welcomeEnabled || welcomeSent.has(ticketId)) return;
  if (db.getMessages.all(ticketId).length > 0) return;
  welcomeSent.add(ticketId);

  const sendMsg = (content, delayMs) => setTimeout(() => emitSupportAutoMessage(ticketId, content), delayMs);
  const messages = [
    [cfg.welcomeText1Enabled, cfg.welcomeText1, cfg.welcomeDelayFirstMs],
    [cfg.welcomeText2Enabled, cfg.welcomeText2, cfg.welcomeDelaySecondMs],
    [cfg.welcomeText3Enabled, cfg.welcomeText3, cfg.welcomeDelayThirdMs]
  ];
  messages.forEach(([enabled, content, delayMs]) => { if (enabled) sendMsg(content, delayMs); });
}

function broadcastAdminTickets() { io.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all()); }

function ticketSnapshot(ticket) {
  const PAGE = 100;
  const total = db.countMessages.get(ticket.id)?.cnt || 0;
  return {
    ticket,
    messages: db.getMessagesRecent.all(ticket.id, PAGE),
    hasMore: total > PAGE
  };
}

function confirmCustomerMessagesSeen(ticket, messageIds) {
  const ids = Array.isArray(messageIds)
    ? [...new Set(messageIds.filter(id => typeof id === 'string'))].slice(0, 100)
    : [];
  for (const id of ids) {
    if (typeof telegram.confirmWebCustomerDelivery === 'function') {
      telegram.confirmWebCustomerDelivery(ticket.id, id);
    } else {
      db.markWebMessageDelivered.run(ticket.id, id);
    }
  }
  return ids.length;
}

function acceptCustomerMessage(data = {}) {
  const { ticketId, sessionToken, content, fileUrl, fileName, fileMime, messageType, clientMessageId } = data;
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket || ticket.id !== ticketId) return { error: 'Unauthorized', status: 401 };
  const msgId = typeof clientMessageId === 'string' && /^[a-f0-9-]{16,64}$/i.test(clientMessageId)
    ? clientMessageId
    : uuidv4();
  const existingMessage = db.getMessageById.get(msgId);
  if (existingMessage) {
    return existingMessage.ticket_id === ticketId && existingMessage.sender === 'user'
      ? { ok: true, id: msgId, duplicate: true, message: existingMessage }
      : { error: 'Invalid message id', status: 409 };
  }
  if (ticket.status === 'closed') return { error: 'Ticket is closed', status: 409 };
  if (fileUrl && !isSafeUploadUrl(fileUrl)) return { error: 'Invalid file', status: 400 };
  const text = String(content || '').trim();
  const maxLength = fileUrl ? 1000 : 4000;
  if (text.length > maxLength) return { error: 'Message too long', maxLength, status: 400 };
  if (!text && !fileUrl) return { error: 'Empty message', status: 400 };
  if (isRateLimited(sessionToken)) {
    return {
      error: 'Rate limit',
      retryAfter: messageRates.get(sessionToken)?.retryAfter || 60,
      status: 429
    };
  }

  warnedTickets.delete(ticket.id);
  const msgType = fileUrl && ['image', 'video', 'audio', 'file'].includes(messageType)
    ? messageType
    : (fileUrl ? 'file' : 'text');
  const safeFileName = String(fileName || '').slice(0, 255) || null;
  const safeFileMime = String(fileMime || '').slice(0, 150) || null;
  db.saveMessage.run(
    msgId, ticketId, 'user', ticket.user_name, text || null, msgType,
    fileUrl || null, safeFileName, safeFileMime, null, null
  );
  const message = {
    id: msgId, ticket_id: ticketId, sender: 'user', sender_name: ticket.user_name,
    content: text || null, message_type: msgType, file_url: fileUrl || null,
    file_name: safeFileName, file_mime: safeFileMime, created_at: new Date().toISOString()
  };
  io.to(`ticket:${ticketId}`).emit('message', message);
  io.to('admin').emit('admin_new_message', { ticketId, message });
  broadcastAdminTickets();
  scheduleOperatorWaitMessage(ticketId, msgId);
  telegram.forwardMessage(ticket, message).catch(error => {
    console.error('[TG] forwardMessage:', error?.message);
  });
  return { ok: true, id: msgId, message };
}

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  socket.on('join_ticket', ({ ticketId, sessionToken }) => {
    const ticket = db.getTicketBySessionAny.get(sessionToken);
    if (!ticket || ticket.id !== ticketId) return socket.emit('error', { message: 'Unauthorized' });
    socket.join(`ticket:${ticketId}`);
    socket.ticketId = ticketId;
    scheduleWelcomeMessages(ticketId);
    // Socket.IO events are best-effort. Always send the persisted transcript
    // after joining so an operator reply cannot be lost in the gap between the
    // HTTP resume request and room subscription (or after a mobile reconnect).
    socket.emit('ticket_snapshot', ticketSnapshot(ticket));

    if (usesLegacyTelegramTopics() &&
        ticket.status === 'open' &&
        ticket.telegram_topic_id &&
        !ticket.telegram_topic_deleted) {
      telegram.checkTopicAlive(ticket).then(alive => {
        if (alive) return;
        db.closeTicket.run(ticketId);
        cancelOperatorWait(ticketId);
        io.to(`ticket:${ticketId}`).emit('ticket_orphaned');
        io.to('admin').emit('admin_ticket_status', { ticketId, status: 'closed' });
        broadcastAdminTickets();
      }).catch(() => {});
    }
  });

  socket.on('customer_messages_seen', ({ ticketId, sessionToken, messageIds } = {}, ack) => {
    const ticket = db.getTicketBySessionAny.get(sessionToken);
    if (!ticket || ticket.id !== ticketId || socket.ticketId !== ticketId) {
      return ack?.({ error: 'Unauthorized' });
    }
    ack?.({ ok: true, delivered: confirmCustomerMessagesSeen(ticket, messageIds) });
  });

  socket.on('typing', () => {
    if (!socket.ticketId) return;
    const ticket = db.getTicketById.get(socket.ticketId);
    if (!ticket || ticket.status === 'closed') return;
    telegram.sendTyping(ticket).catch(() => {});
    io.to('admin').emit('admin_user_typing', { ticketId: socket.ticketId });
  });

  socket.on('send_message', async (data = {}, ack) => {
    try {
      const { ticketId, sessionToken, content, fileUrl, fileName, fileMime, messageType, clientMessageId } = data;
      const ticket = db.getTicketBySessionAny.get(sessionToken);
      if (!ticket || ticket.id !== ticketId) {
        if (ack) ack({ error: 'Unauthorized' });
        return;
      }
      const msgId = typeof clientMessageId === 'string' && /^[a-f0-9-]{16,64}$/i.test(clientMessageId) ? clientMessageId : uuidv4();
      const existingMessage = db.getMessageById.get(msgId);
      if (existingMessage) {
        if (existingMessage.ticket_id === ticketId && existingMessage.sender === 'user') ack?.({ ok: true, id: msgId, duplicate: true });
        else ack?.({ error: 'Invalid message id' });
        return;
      }
      if (ticket.status === 'closed') {
        if (ack) ack({ error: 'Ticket is closed' });
        return;
      }
      if (fileUrl && !isSafeUploadUrl(fileUrl)) {
        if (ack) ack({ error: 'Invalid file' });
        return;
      }
      const text = String(content || '').trim();
      const maxLength = fileUrl ? 1000 : 4000;
      if (text.length > maxLength) {
        ack?.({ error: 'Message too long', maxLength });
        return;
      }
      if (!text && !fileUrl) {
        if (ack) ack({ error: 'Empty message' });
        return;
      }
      if (isRateLimited(sessionToken)) {
        const retryAfter = messageRates.get(sessionToken)?.retryAfter || 60;
        if (ack) ack({ error: 'Rate limit', retryAfter });
        return;
      }

      warnedTickets.delete(ticket.id);
      const msgType = fileUrl && ['image', 'video', 'audio', 'file'].includes(messageType) ? messageType : (fileUrl ? 'file' : 'text');
      const safeFileName = String(fileName || '').slice(0, 255) || null;
      const safeFileMime = String(fileMime || '').slice(0, 150) || null;
      db.saveMessage.run(msgId, ticketId, 'user', ticket.user_name, text || null, msgType, fileUrl || null, safeFileName, safeFileMime, null, null);
      const message = {
        id: msgId, ticket_id: ticketId, sender: 'user', sender_name: ticket.user_name,
        content: text || null, message_type: msgType, file_url: fileUrl || null,
        file_name: safeFileName, file_mime: safeFileMime, created_at: new Date().toISOString()
      };
      io.to(`ticket:${ticketId}`).emit('message', message);
      io.to('admin').emit('admin_new_message', { ticketId, message });
      broadcastAdminTickets();
      scheduleOperatorWaitMessage(ticketId, msgId);
      telegram.forwardMessage(ticket, message).catch(e => console.error('[TG] forwardMessage:', e?.message));
      ack?.({ ok: true, id: msgId });
    } catch (err) {
      console.error('[Socket] send_message error:', err);
      ack?.({ error: 'Server error' });
    }
  });

  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));

  socket.on('admin_auth', ({ token }) => {
    if (!isAdminToken(token)) return socket.emit('admin_auth_error', { message: 'Invalid token' });
    socket.isAdmin = true;
    socket.adminUsesToken = !!(ADMIN_TOKEN && safeEqualString(token, ADMIN_TOKEN));
    socket.adminUserId = getMiniAdminSession(token)?.userId || null;
    socket.canManageSettings = socketCanManageSettings(socket);
    socket.join('admin');
    socket.emit('admin_auth_ok', { permissions: { canManageSettings: socket.canManageSettings } });
    socket.emit('admin_tickets', db.getTicketsForAdmin.all());
  });

  socket.on('admin_open_ticket', ({ ticketId }) => {
    if (!socket.isAdmin) return;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket) return;
    const messages = db.getMessages.all(ticketId);
    db.markSupportRead.run(ticketId);
    io.to(`ticket:${ticketId}`).emit('messages_read');
    socket.emit('admin_ticket_messages', { ticketId, messages, ticket });
    broadcastAdminTickets();
  });

  socket.on('admin_refresh_state', ({
    ticketId,
    knownMessageId = '',
    knownTicketStatus = '',
    includeTickets = false
  } = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    if (includeTickets) socket.emit('admin_tickets', db.getTicketsForAdmin.all());
    if (ticketId) {
      const ticket = db.getTicketById.get(ticketId);
      const latestMessage = ticket ? db.getLatestMessageForTicket.get(ticketId) : null;
      const messagesChanged = String(latestMessage?.id || '') !== String(knownMessageId || '');
      const ticketChanged = !ticket || String(ticket.status || '') !== String(knownTicketStatus || '');
      if (ticket && (messagesChanged || ticketChanged)) {
        socket.emit('admin_ticket_messages', {
          ticketId,
          ticket,
          messages: db.getMessages.all(ticketId)
        });
      }
      return ack?.({ ok: true, messagesChanged, ticketChanged });
    }
    ack?.({ ok: true });
  });

  socket.on('admin_update_ticket_meta', ({ ticketId, tags = '', note = '' } = {}) => {
    if (!socket.isAdmin) return;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket) return;

    const cleanTags = String(tags || '')
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');
    const cleanNote = String(note || '').trim().slice(0, 1200);

    db.updateTicketMeta.run(cleanTags, cleanNote, ticketId);
    const updated = db.getTicketById.get(ticketId);
    socket.emit('admin_ticket_meta', updated);
    io.to('admin').emit('admin_ticket_updated', updated);
    broadcastAdminTickets();
  });

  socket.on('admin_get_settings', () => {
    if (!socket.isAdmin) return;
    if (!socketCanManageSettings(socket)) return socket.emit('admin_settings_forbidden');
    socket.emit('admin_settings', {
      ...loadSettings(),
      telegramMode: typeof telegram.status === 'function' ? telegram.status()?.mode : null
    });
  });

  socket.on('admin_update_settings', (payload = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    if (!socketCanManageSettings(socket)) return ack?.({ error: 'Недостаточно прав для изменения настроек' });
    try {
      const cfg = saveSettings(payload);
      const visibleCfg = {
        ...cfg,
        telegramMode: typeof telegram.status === 'function' ? telegram.status()?.mode : null
      };
      emitToSettingsManagers('admin_settings_updated', visibleCfg, socket.id);
      if (typeof telegram.refreshOpenTicketTranscripts === 'function') {
        telegram.refreshOpenTicketTranscripts().catch(error => {
          console.warn('[Settings] Telegram Rich refresh:', error?.message || error);
        });
      }
      maintenance.refreshStatus({ alertDisk: false }).then(status => {
        io.to('admin').emit('maintenance_updated', status);
      }).catch(() => {});
      ack?.({ ok: true, settings: visibleCfg, savedAt: new Date().toISOString() });
    } catch (error) {
      console.error('[Settings] save:', error);
      ack?.({ error: 'Не удалось сохранить настройки' });
    }
  });

  socket.on('admin_test_operational_alert', async (_payload = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    if (!socketCanManageSettings(socket)) return ack?.({ error: 'Недостаточно прав для настройки уведомлений' });
    const cfg = loadSettings();
    const telegramStatus = typeof telegram.status === 'function' ? telegram.status() : null;
    if (!cfg.operationalAlertsEnabled) {
      return ack?.({ error: 'Сначала включите и сохраните системные уведомления' });
    }
    if (!telegramStatus?.configured || !telegramStatus?.connected) {
      return ack?.({ error: 'Telegram-бот сейчас не подключён' });
    }
    if (telegramStatus.mode === 'private' && !telegramStatus.operatorAccessConfigured) {
      return ack?.({ error: 'Не настроен ни один оператор Telegram' });
    }
    try {
      await telegram.notifyOperationalIssue(
        `manual-test-${Date.now()}`,
        'Тест системных уведомлений',
        'Если вы видите это сообщение, канал контроля работает.'
      );
      ack?.({ ok: true });
    } catch (error) {
      ack?.({ error: error?.message || 'Не удалось отправить тестовое уведомление' });
    }
  });

  socket.on('admin_get_operators', (_payload = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    if (!socketCanManageSettings(socket)) return ack?.({ error: 'Недостаточно прав для управления операторами' });
    ack?.({
      ok: true,
      operators: db.listTelegramOperators.all().map(operator => ({
        telegramUserId: operator.telegram_user_id,
        displayName: operator.display_name,
        username: operator.username || '',
        active: !!operator.active,
        canManageSettings: !!operator.can_manage_settings,
        lastSeenAt: operator.last_seen_at || null
      }))
    });
  });

  socket.on('admin_save_operator', (payload = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    if (!socketCanManageSettings(socket)) return ack?.({ error: 'Недостаточно прав для управления операторами' });
    const operator = normalizeManagedOperator(payload);
    if (operator.error) return ack?.({ error: operator.error });
    try {
      db.saveManagedTelegramOperator.run(
        operator.telegramUserId,
        operator.displayName,
        operator.username,
        operator.active ? 1 : 0,
        operator.canManageSettings ? 1 : 0
      );
      const saved = db.getTelegramOperator.get(operator.telegramUserId);
      emitToSettingsManagers('admin_operators_updated');
      ack?.({
        ok: true,
        operator: {
          telegramUserId: saved.telegram_user_id,
          displayName: saved.display_name,
          username: saved.username || '',
          active: !!saved.active,
          canManageSettings: !!saved.can_manage_settings,
          lastSeenAt: saved.last_seen_at || null
        }
      });
    } catch (error) {
      console.error('[Operators] save:', error);
      ack?.({ error: 'Не удалось сохранить оператора' });
    }
  });

  socket.on('admin_reply', async (data = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    const { ticketId, content, fileUrl, fileName, fileMime, messageType, clientMessageId } = data;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket) return ack?.({ error: 'Ticket not found' });
    const msgId = typeof clientMessageId === 'string' && /^[a-f0-9-]{16,64}$/i.test(clientMessageId) ? clientMessageId : uuidv4();
    const existingMessage = db.getMessageById.get(msgId);
    if (existingMessage) {
      if (existingMessage.ticket_id === ticketId && existingMessage.sender === 'support') ack?.({ ok: true, id: msgId, duplicate: true });
      else ack?.({ error: 'Invalid message id' });
      return;
    }
    if (ticket.status === 'closed') return ack?.({ error: 'Ticket is closed' });
    const text = (content || '').trim();
    if (!text && !fileUrl) return ack?.({ error: 'Empty message' });
    if (fileUrl && !isSafeUploadUrl(fileUrl)) {
      socket.emit('admin_error', { message: 'Invalid file' });
      return ack?.({ error: 'Invalid file' });
    }
    const maxLength = fileUrl ? 1000 : 4000;
    if (text.length > maxLength) return ack?.({ error: 'Message too long', maxLength });
    const cfg = loadSettings();
    const msgType = fileUrl && ['image', 'video', 'audio', 'file'].includes(messageType) ? messageType : (fileUrl ? 'file' : 'text');
    const safeFileName = String(fileName || '').slice(0, 255) || null;
    const safeFileMime = String(fileMime || '').slice(0, 150) || null;
    db.saveMessage.run(msgId, ticketId, 'support', cfg.supportName, text || null, msgType, fileUrl || null, safeFileName, safeFileMime, null, null);
    db.markSupportRead.run(ticketId);
    telegram.clearTicketReminders?.(ticketId).catch(e => {
      console.warn('[Admin] clear Telegram reminders:', e?.message);
    });
    const message = {
      id: msgId, ticket_id: ticketId, sender: 'support', sender_name: cfg.supportName,
      content: text || null, message_type: msgType, file_url: fileUrl || null, file_name: safeFileName, file_mime: safeFileMime,
      created_at: new Date().toISOString()
    };
    io.to(`ticket:${ticketId}`).emit('message', message);
    io.to('admin').emit('admin_new_message', { ticketId, message });
    cancelOperatorWait(ticketId);
    broadcastAdminTickets();
    push.send(ticketId, text || safeFileName || 'Новое сообщение').catch(() => {});
    const freshTicket = db.getTicketById.get(ticketId);
    telegram.forwardMessage(freshTicket, message).catch(e => console.error('[Admin] forwardMessage:', e?.message));
    telegram.deliverCustomerReply?.(freshTicket, message).catch(e => {
      console.error('[Admin] customer delivery:', e?.message);
    });
    ack?.({ ok: true, id: msgId });
  });

  socket.on('admin_typing', ({ ticketId }) => {
    if (!socket.isAdmin) return;
    io.to(`ticket:${ticketId}`).emit('typing_support');
    const ticket = db.getTicketById.get(ticketId);
    telegram.sendCustomerTyping?.(ticket).catch(() => {});
  });

  socket.on('admin_send_customer_control', async ({ ticketId } = {}, ack) => {
    if (!socket.isAdmin) return ack?.({ error: 'Unauthorized' });
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket) return ack?.({ error: 'Тикет не найден' });
    if (ticket.status !== 'open') {
      return ack?.({ error: 'Тикет уже закрыт' });
    }
    if (typeof telegram.sendCustomerClosePrompt !== 'function') {
      return ack?.({ error: 'Действие недоступно' });
    }
    try {
      await telegram.sendCustomerClosePrompt(ticket, { repin: true });
      ack?.({ ok: true });
    } catch (error) {
      console.error('[Admin] customer close prompt:', error?.message);
      ack?.({ error: 'Не удалось отправить предложение клиенту' });
    }
  });

  socket.on('admin_close_ticket', ({ ticketId }) => {
    if (!socket.isAdmin) return;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;
    db.closeTicket.run(ticket.id);
    cancelOperatorWait(ticketId);
    io.to(`ticket:${ticketId}`).emit('ticket_closed', { by: 'support' });
    io.to('admin').emit('admin_ticket_status', { ticketId, status: 'closed' });
    broadcastAdminTickets();
    telegram.notifyTicketClosed(ticket, {
      customerReason: loadSettings().telegramCustomerClosedBySupportText
    }).catch(() => {});
  });

});

const staleTicketsQuery = db.db.prepare(`
  SELECT t.* FROM tickets t
  JOIN messages m ON m.id = (
    SELECT id FROM messages
    WHERE ticket_id = t.id AND sender != 'system' AND COALESCE(is_auto, 0) = 0
    ORDER BY created_at DESC LIMIT 1
  )
  WHERE t.status = 'open'
  AND m.sender = 'support'
  AND m.created_at < datetime('now', ?)
  AND EXISTS (SELECT 1 FROM messages u WHERE u.ticket_id = t.id AND u.sender = 'user')
`);

const warnTicketsQuery = db.db.prepare(`
  SELECT t.* FROM tickets t
  JOIN messages m ON m.id = (
    SELECT id FROM messages
    WHERE ticket_id = t.id AND sender != 'system' AND COALESCE(is_auto, 0) = 0
    ORDER BY created_at DESC LIMIT 1
  )
  WHERE t.status = 'open'
  AND m.sender = 'support'
  AND m.created_at < datetime('now', ?)
  AND m.created_at >= datetime('now', ?)
  AND EXISTS (SELECT 1 FROM messages u WHERE u.ticket_id = t.id AND u.sender = 'user')
`);

let _inactivityRunning = false;
async function inactivityCheck() {
  if (_inactivityRunning) return;
  _inactivityRunning = true;
  try {
    const cfg = loadSettings();
    if (!cfg.inactivityEnabled) return;
    const warnCutoff = `-${cfg.inactivityWarnMinutes} minutes`;
    const closeCutoff = `-${cfg.inactivityCloseMinutes} minutes`;
    const remaining = Math.max(1, cfg.inactivityCloseMinutes - cfg.inactivityWarnMinutes);

    const toWarn = warnTicketsQuery.all(warnCutoff, closeCutoff);
    for (const ticket of toWarn) {
      if (warnedTickets.has(ticket.id)) continue;
      warnedTickets.add(ticket.id);
      const msgId = uuidv4();
      const created_at = new Date().toISOString();
      const content = cfg.inactivityWarningText;
      db.saveMessage.run(msgId, ticket.id, 'system', 'Система', content, 'text', null, null, null, null, null);
      io.to(`ticket:${ticket.id}`).emit('message', { id: msgId, ticket_id: ticket.id, sender: 'system', sender_name: 'Система', content, message_type: 'text', file_url: null, file_name: null, file_mime: null, created_at });
      telegram.warnInactivity(ticket, { warnMinutes: cfg.inactivityWarnMinutes, remainingMinutes: remaining }).catch(() => {});
    }

    const stale = staleTicketsQuery.all(closeCutoff);
    for (const ticket of stale) {
      db.closeTicket.run(ticket.id);
      cancelOperatorWait(ticket.id);
      warnedTickets.delete(ticket.id);
      const msgId = uuidv4();
      const created_at = new Date().toISOString();
      const content = cfg.inactivityCloseText;
      db.saveMessage.run(msgId, ticket.id, 'system', 'Система', content, 'text', null, null, null, null, null);
      io.to(`ticket:${ticket.id}`).emit('message', { id: msgId, ticket_id: ticket.id, sender: 'system', sender_name: 'Система', content, message_type: 'text', file_url: null, file_name: null, file_mime: null, created_at });
      io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'inactivity' });
      io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
      telegram.autoCloseTicket(ticket, { minutes: cfg.inactivityCloseMinutes }).catch(() => {});
      console.log(`[Auto] Closed inactive ticket ${ticket.id.slice(0, 8)}`);
    }
    if (stale.length > 0) broadcastAdminTickets();
  } catch (e) {
    console.error('[Auto] inactivityCheck:', e.message);
  } finally {
    _inactivityRunning = false;
  }
}
setInterval(inactivityCheck, 60 * 1000);

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError || err.message === 'UNSUPPORTED_FILE_TYPE') {
    telegram.notifyOperationalIssue('upload-failed', 'Клиенту не удалось загрузить файл', err.message).catch(() => {});
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Файл слишком большой'
      : 'Этот формат файла пока не поддерживается';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
  }
  console.error('[HTTP]', err);
  res.status(500).json({ error: 'Server error' });
});

function detailedHealth() {
  return {
    ok: true,
    version: process.env.APP_VERSION || 'unknown',
    uptime: Math.floor(process.uptime()),
    telegram: typeof telegram.status === 'function' ? telegram.status() : null,
    maintenance: maintenance.healthStatus()
  };
}

// This endpoint is intentionally safe for public load balancers and Docker
// healthchecks. Operational metadata belongs to the authenticated admin route.
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, version: process.env.APP_VERSION || 'unknown' });
});

app.get('/api/admin/health', (req, res) => {
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.set('Cache-Control', 'no-store');
  res.json(detailedHealth());
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => console.log(`[Server] Running on http://${HOST}:${PORT}`));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Server] ${signal}: stopping gracefully`);
  const forceExit = setTimeout(() => process.exit(1), 10000);
  forceExit.unref?.();
  await telegram.shutdown?.().catch(error => {
    console.error('[Server] Telegram shutdown:', error?.message || error);
  });
  server.close(error => {
    clearTimeout(forceExit);
    try { if (db.db.open) db.db.close(); } catch {}
    process.exit(error ? 1 : 0);
  });
}

process.once('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.once('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });
