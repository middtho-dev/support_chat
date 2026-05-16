require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
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

const IMG_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.bmp','.tiff','.avif']);
const VID_EXTS = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);
const AUD_EXTS = new Set(['.mp3','.m4a','.aac','.ogg','.wav','.flac','.opus']);
const ALLOWED_MIMES = new Set([
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-zip-compressed','application/x-zip','application/x-7z-compressed',
  'application/x-rar-compressed','application/vnd.rar','text/plain','text/csv'
]);

function mimeFromExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMG_EXTS.has(ext)) return 'image/jpeg';
  if (VID_EXTS.has(ext)) return 'video/mp4';
  if (AUD_EXTS.has(ext)) return 'audio/mpeg';
  return null;
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

app.get('/admin', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('<h1>Admin panel disabled</h1><p>Set ADMIN_TOKEN in .env to enable.</p>');
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});
app.use(express.static(path.join(__dirname, '../public')));

function isWithinWorkHours(cfg = loadSettings()) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: cfg.timezone }).format(new Date()));
  return hour >= cfg.workStartHour && hour < cfg.workEndHour;
}

function publicConfig() {
  const cfg = loadSettings();
  return { settings: cfg, online: isWithinWorkHours(cfg) };
}

app.post('/api/session/start', (req, res) => {
  const cfg = loadSettings();
  if (cfg.offhoursEnabled && !isWithinWorkHours(cfg)) return res.status(403).json({ error: 'Off hours', message: cfg.offhoursRejectText });
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
  const cfg = loadSettings();
  if (req.file.size > cfg.uploadMaxMb * 1024 * 1024) {
    fs.unlink(req.file.path, () => {});
    return res.status(413).json({ error: `File too large. Max ${cfg.uploadMaxMb} MB` });
  }

  let mime = req.file.mimetype;
  if (mime === 'application/octet-stream') mime = mimeFromExt(req.file.originalname) || mime;
  let type = 'file';
  if (mime.startsWith('image/')) type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname, mime, type });
});

app.post('/api/tickets/:ticketId/close', (req, res) => {
  const { sessionToken } = req.body;
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!sessionToken || ticket.session_token !== sessionToken) return res.status(403).json({ error: 'Forbidden' });

  db.closeTicket.run(ticket.id);
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

function scheduleWelcomeMessages(ticketId) {
  const cfg = loadSettings();
  if (!cfg.welcomeEnabled || welcomeSent.has(ticketId)) return;
  if (db.getMessages.all(ticketId).length > 0) return;
  welcomeSent.add(ticketId);

  const sendMsg = (content, delayMs) => setTimeout(() => {
    const freshCfg = loadSettings();
    const ticket = db.getTicketById.get(ticketId);
    const text = String(content || '').trim();
    if (!ticket || ticket.status === 'closed' || !text) return;
    const id = uuidv4();
    const created_at = new Date().toISOString();
    db.saveMessage.run(id, ticketId, 'support', freshCfg.supportName, text, 'text', null, null, null, null, null);
    io.to(`ticket:${ticketId}`).emit('message', {
      id, ticket_id: ticketId, sender: 'support', sender_name: freshCfg.supportName,
      content: text, message_type: 'text', file_url: null, file_name: null, file_mime: null, created_at
    });
  }, delayMs);

  sendMsg(cfg.welcomeText1, cfg.welcomeDelayFirstMs);
  sendMsg(cfg.welcomeText2, cfg.welcomeDelaySecondMs);
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
      const cfg = loadSettings();
      if (cfg.offhoursEnabled && !isWithinWorkHours(cfg)) {
        if (ack) ack({ error: 'Off hours', message: cfg.offhoursRejectText });
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
      telegram.forwardMessage(ticket, message).catch(e => console.error('[TG] forwardMessage:', e?.message));
      ack?.({ ok: true, id: msgId });
    } catch (err) {
      console.error('[Socket] send_message error:', err);
      ack?.({ error: 'Server error' });
    }
  });

  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));

  socket.on('admin_auth', ({ token }) => {
    if (!ADMIN_TOKEN || !token || token !== ADMIN_TOKEN) return socket.emit('admin_auth_error', { message: 'Invalid token' });
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

  socket.on('admin_reply', async ({ ticketId, content }) => {
    if (!socket.isAdmin) return;
    const text = (content || '').trim();
    if (!text) return;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;
    const cfg = loadSettings();
    const msgId = uuidv4();
    db.saveMessage.run(msgId, ticketId, 'support', cfg.supportName, text, 'text', null, null, null, null, null);
    db.markSupportRead.run(ticketId);
    const message = {
      id: msgId, ticket_id: ticketId, sender: 'support', sender_name: cfg.supportName,
      content: text, message_type: 'text', file_url: null, file_name: null, file_mime: null,
      created_at: new Date().toISOString()
    };
    io.to(`ticket:${ticketId}`).emit('message', message);
    io.to('admin').emit('admin_new_message', { ticketId, message });
    broadcastAdminTickets();
    push.send(ticketId, text).catch(() => {});
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
    io.to(`ticket:${ticketId}`).emit('ticket_closed', { by: 'support' });
    socket.emit('admin_ticket_status', { ticketId, status: 'closed' });
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
        socket.emit('admin_error', { message: loadSettings().telegramTopicDeletedAdminText });
        return broadcastAdminTickets();
      }
    }
    io.to(`ticket:${ticketId}`).emit('ticket_reopened');
    socket.emit('admin_ticket_status', { ticketId, status: 'open' });
    broadcastAdminTickets();
  });
});

const staleTicketsQuery = db.db.prepare(`
  SELECT t.* FROM tickets t
  LEFT JOIN (
    SELECT ticket_id, MAX(created_at) AS last_msg
    FROM messages WHERE sender != 'system'
    GROUP BY ticket_id
  ) m ON m.ticket_id = t.id
  WHERE t.status = 'open'
  AND COALESCE(m.last_msg, t.created_at) < datetime('now', ?)
`);

const warnTicketsQuery = db.db.prepare(`
  SELECT t.* FROM tickets t
  LEFT JOIN (
    SELECT ticket_id, MAX(created_at) AS last_msg
    FROM messages WHERE sender != 'system'
    GROUP BY ticket_id
  ) m ON m.ticket_id = t.id
  WHERE t.status = 'open'
  AND COALESCE(m.last_msg, t.created_at) < datetime('now', ?)
  AND COALESCE(m.last_msg, t.created_at) >= datetime('now', ?)
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

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Server] Running on http://localhost:${PORT}`));
