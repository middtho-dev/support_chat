require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const telegram = require('./telegram');
const push = require('./push');
const { loadSettings, saveSettings } = require('./settings');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
  maxHttpBufferSize: 50 * 1024 * 1024
});

telegram.init(io);
push.init();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DISPLAY_IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.webp']);
const IMG_EXTS = new Set([...DISPLAY_IMAGE_EXTS,'.heic','.heif','.bmp','.tif','.tiff','.avif']);
const VID_EXTS = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);
const AUD_EXTS = new Set(['.mp3','.m4a','.aac','.ogg','.wav','.flac','.opus']);
const ALLOWED_MIMES = new Set([
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-zip-compressed','application/x-zip','application/x-7z-compressed',
  'application/x-rar-compressed','application/vnd.rar','text/plain','text/csv',
  'image/heic','image/heif','image/avif','image/tiff','image/bmp'
]);

function mimeFromExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  const byExt = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.opus': 'audio/opus'
  };
  if (byExt[ext]) return byExt[ext];
  return null;
}

function uploadMetadata(file) {
  const ext = path.extname(file.originalname || file.filename || '').toLowerCase();
  let mime = file.mimetype;
  if (!mime || mime === 'application/octet-stream') mime = mimeFromExt(file.originalname) || mime || 'application/octet-stream';

  let type = 'file';
  if (mime.startsWith('image/') && DISPLAY_IMAGE_EXTS.has(ext)) type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';

  return { name: file.originalname, mime, type };
}

function isSafeUploadUrl(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return false;
  if (!fileUrl.startsWith('/uploads/')) return false;
  let decoded;
  try {
    decoded = path.normalize(decodeURIComponent(fileUrl).replace(/^\/+/, ''));
  } catch {
    return false;
  }
  if (decoded.startsWith('..') || path.isAbsolute(decoded)) return false;
  const fp = path.resolve(__dirname, '../public', decoded);
  const uploadsDir = path.resolve(UPLOADS_DIR);
  return fp === uploadsDir || fp.startsWith(uploadsDir + path.sep);
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isAdminToken(token) {
  return !!ADMIN_TOKEN && safeEqualString(token, ADMIN_TOKEN);
}

function isAdminRequest(req) {
  return isAdminToken(req.body?.adminToken || req.query?.adminToken || req.get('x-admin-token'));
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
    let mime = file.mimetype;
    if (mime === 'application/octet-stream') mime = mimeFromExt(file.originalname) || mime;
    const ok = mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/') || ALLOWED_MIMES.has(mime);
    ok ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/logo.png'));
});

app.get('/admin', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('<h1>Admin panel disabled</h1><p>Set ADMIN_TOKEN in .env to enable.</p>');
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});
app.use(express.static(path.join(__dirname, '../public')));

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
  telegram.createTopic(ticketId, name).catch(e => console.error('[TG] createTopic:', e?.message));

  const newTicket = db.getTicketById.get(ticketId);
  if (newTicket) io.to('admin').emit('admin_new_ticket', newTicket);
  res.json({ sessionToken, ticketId, userName: name });
});

app.post('/api/session/resume', (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken || typeof sessionToken !== 'string') return res.status(400).json({ error: 'Token required' });
  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket) return res.status(404).json({ error: 'No active ticket' });
  if (ticket.status === 'closed' && ticket.telegram_topic_deleted) return res.json({ orphaned: true });

  const PAGE = 100;
  const total = db.countMessages.get(ticket.id)?.cnt || 0;
  const messages = db.getMessagesRecent.all(ticket.id, PAGE);
  const cfg = loadSettings();
  res.json({ ticket, messages, hasMore: total > PAGE, settings: cfg, online: isWithinWorkHours(cfg) });
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
    return res.status(413).json({ error: `File too large. Max ${cfg.uploadMaxMb} MB` });
  }

  const meta = uploadMetadata(req.file);
  res.json({ url: `/uploads/${req.file.filename}`, ...meta });
});

app.post('/api/tickets/:ticketId/close', (req, res) => {
  const { sessionToken } = req.body;
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!sessionToken || ticket.session_token !== sessionToken) return res.status(403).json({ error: 'Forbidden' });

  db.closeTicket.run(ticket.id);
  cancelOperatorWait(ticket.id);
  telegram.notifyTicketClosed(ticket).catch(e => console.error('[TG] notifyTicketClosed:', e?.message));
  io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'user' });
  io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  broadcastAdminTickets();
  res.json({ ok: true });
});

app.post('/api/tickets/:ticketId/reopen', async (req, res) => {
  const { sessionToken } = req.body;
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!sessionToken || ticket.session_token !== sessionToken) return res.status(403).json({ error: 'Forbidden' });
  if (ticket.telegram_topic_deleted) return res.status(409).json({ error: 'Topic deleted' });

  db.reopenTicket.run(ticket.id);
  try {
    await telegram.notifyTicketReopened(ticket);
  } catch (e) {
    if (e.topicDeleted) {
      db.closeTicket.run(ticket.id);
      cancelOperatorWait(ticket.id);
      io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'system' });
      io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
      return res.status(409).json({ error: 'Topic deleted' });
    }
  }
  io.to(`ticket:${ticket.id}`).emit('ticket_reopened');
  io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'open' });
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

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  socket.on('join_ticket', ({ ticketId, sessionToken }) => {
    const ticket = db.getTicketBySessionAny.get(sessionToken);
    if (!ticket || ticket.id !== ticketId) return socket.emit('error', { message: 'Unauthorized' });
    socket.join(`ticket:${ticketId}`);
    socket.ticketId = ticketId;
    scheduleWelcomeMessages(ticketId);

    if (ticket.status === 'open' && ticket.telegram_topic_id && !ticket.telegram_topic_deleted) {
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

  socket.on('typing', () => {
    if (!socket.ticketId) return;
    const ticket = db.getTicketById.get(socket.ticketId);
    if (!ticket || ticket.status === 'closed') return;
    telegram.sendTyping(ticket).catch(() => {});
    io.to('admin').emit('admin_user_typing', { ticketId: socket.ticketId });
  });

  socket.on('send_message', async (data, ack) => {
    try {
      const { ticketId, sessionToken, content, fileUrl, fileName, fileMime, messageType } = data;
      const ticket = db.getTicketBySessionAny.get(sessionToken);
      if (!ticket || ticket.id !== ticketId) {
        if (ack) ack({ error: 'Unauthorized' });
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
      if (!content && !fileUrl) {
        if (ack) ack({ error: 'Empty message' });
        return;
      }
      if (isRateLimited(sessionToken)) {
        const retryAfter = messageRates.get(sessionToken)?.retryAfter || 60;
        if (ack) ack({ error: 'Rate limit', retryAfter });
        return;
      }

      warnedTickets.delete(ticket.id);
      const msgId = uuidv4();
      const msgType = messageType || 'text';
      db.saveMessage.run(msgId, ticketId, 'user', ticket.user_name, content || null, msgType, fileUrl || null, fileName || null, fileMime || null, null, null);
      const message = {
        id: msgId, ticket_id: ticketId, sender: 'user', sender_name: ticket.user_name,
        content: content || null, message_type: msgType, file_url: fileUrl || null,
        file_name: fileName || null, file_mime: fileMime || null, created_at: new Date().toISOString()
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
    socket.join('admin');
    socket.emit('admin_auth_ok');
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
    socket.emit('admin_settings', loadSettings());
  });

  socket.on('admin_update_settings', (payload = {}) => {
    if (!socket.isAdmin) return;
    const cfg = saveSettings(payload);
    socket.emit('admin_settings', cfg);
    io.to('admin').emit('admin_settings_updated', cfg);
  });

  socket.on('admin_reply', async ({ ticketId, content, fileUrl, fileName, fileMime, messageType }) => {
    if (!socket.isAdmin) return;
    const text = (content || '').trim();
    if (!text && !fileUrl) return;
    if (fileUrl && !isSafeUploadUrl(fileUrl)) return socket.emit('admin_error', { message: 'Invalid file' });
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;
    const cfg = loadSettings();
    const msgId = uuidv4();
    const msgType = messageType || (fileUrl ? 'file' : 'text');
    db.saveMessage.run(msgId, ticketId, 'support', cfg.supportName, text || null, msgType, fileUrl || null, fileName || null, fileMime || null, null, null);
    db.markSupportRead.run(ticketId);
    const message = {
      id: msgId, ticket_id: ticketId, sender: 'support', sender_name: cfg.supportName,
      content: text || null, message_type: msgType, file_url: fileUrl || null, file_name: fileName || null, file_mime: fileMime || null,
      created_at: new Date().toISOString()
    };
    io.to(`ticket:${ticketId}`).emit('message', message);
    io.to('admin').emit('admin_new_message', { ticketId, message });
    cancelOperatorWait(ticketId);
    broadcastAdminTickets();
    push.send(ticketId, text || fileName || 'Новое сообщение').catch(() => {});
    telegram.forwardMessage(db.getTicketById.get(ticketId), message).catch(e => console.error('[Admin] forwardMessage:', e?.message));
  });

  socket.on('admin_typing', ({ ticketId }) => {
    if (!socket.isAdmin) return;
    io.to(`ticket:${ticketId}`).emit('typing_support');
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
    telegram.notifyTicketClosed(ticket).catch(() => {});
  });

  socket.on('admin_reopen_ticket', async ({ ticketId }) => {
    if (!socket.isAdmin) return;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status !== 'closed') return;
    if (ticket.telegram_topic_deleted) return socket.emit('admin_error', { message: loadSettings().telegramTopicDeletedAdminText });
    db.reopenTicket.run(ticket.id);
    try {
      await telegram.notifyTicketReopened(ticket);
    } catch (e) {
      if (e.topicDeleted) {
        db.closeTicket.run(ticket.id);
        cancelOperatorWait(ticket.id);
        socket.emit('admin_error', { message: loadSettings().telegramTopicDeletedAdminText });
        return broadcastAdminTickets();
      }
    }
    io.to(`ticket:${ticketId}`).emit('ticket_reopened');
    io.to('admin').emit('admin_ticket_status', { ticketId, status: 'open' });
    broadcastAdminTickets();
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
  if (err instanceof multer.MulterError || err.message === 'File type not allowed') {
    return res.status(400).json({ error: err.message });
  }
  console.error('[HTTP]', err);
  res.status(500).json({ error: 'Server error' });
});

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Server] Running on http://localhost:${PORT}`));
