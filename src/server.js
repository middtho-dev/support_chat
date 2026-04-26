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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
  maxHttpBufferSize: 50 * 1024 * 1024
});

telegram.init(io);
push.init();

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${uuidv4()}${ext}`);
  }
});

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip'
]);

const IMG_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.heic','.heif','.bmp','.tiff','.avif']);
const VID_EXTS = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm']);
const AUD_EXTS = new Set(['.mp3','.m4a','.aac','.ogg','.wav','.flac','.opus']);

function mimeFromExt(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (IMG_EXTS.has(ext)) return 'image/jpeg';
  if (VID_EXTS.has(ext)) return 'video/mp4';
  if (AUD_EXTS.has(ext)) return 'audio/mpeg';
  return null;
}

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    let mime = file.mimetype;
    if (mime === 'application/octet-stream') mime = mimeFromExt(file.originalname) || mime;
    const ok = mime.startsWith('image/') || mime.startsWith('video/') ||
                mime.startsWith('audio/') || ALLOWED_MIMES.has(mime);
    ok ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Admin panel route (before static so /admin resolves to admin.html)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
app.get('/admin', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('<h1>Admin panel disabled</h1><p>Set ADMIN_TOKEN in .env to enable.</p>');
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

// ─── REST API ────────────────────────────────────────────────────────────────

app.post('/api/session/start', (req, res) => {
  const raw = req.body?.name;
  if (!raw || typeof raw !== 'string') return res.status(400).json({ error: 'Name required' });
  const name = raw.trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'Name required' });

  const sessionToken = uuidv4();
  const ticketId = uuidv4();

  db.createTicket.run(ticketId, name, sessionToken);
  telegram.createTopic(ticketId, name).catch(e => console.error('[TG] createTopic:', e?.message));

  // Notify admin panel of new ticket
  const newTicket = db.getTicketById.get(ticketId);
  if (newTicket) io.to('admin').emit('admin_new_ticket', newTicket);

  res.json({ sessionToken, ticketId, userName: name });
});

app.post('/api/session/resume', (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken || typeof sessionToken !== 'string') {
    return res.status(400).json({ error: 'Token required' });
  }

  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket) return res.status(404).json({ error: 'No active ticket' });

  // Ticket closed + topic was deleted → tell client to start fresh
  if (ticket.status === 'closed' && ticket.telegram_topic_deleted) {
    return res.json({ orphaned: true });
  }

  const messages = db.getMessages.all(ticket.id);
  res.json({ ticket, messages });
});

app.get('/api/tickets/:ticketId/messages', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json(db.getMessages.all(ticket.id));
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

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
  io.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());

  res.json({ ok: true });
});

app.post('/api/tickets/:ticketId/reopen', async (req, res) => {
  const { sessionToken } = req.body;
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (!sessionToken || ticket.session_token !== sessionToken) return res.status(403).json({ error: 'Forbidden' });

  // Refuse if Telegram topic was deleted
  if (ticket.telegram_topic_deleted) {
    return res.status(409).json({ error: 'Topic deleted' });
  }

  db.reopenTicket.run(ticket.id);

  try {
    await telegram.notifyTicketReopened(ticket);
  } catch (e) {
    if (e.topicDeleted) {
      // Undo reopen — topic is gone
      db.closeTicket.run(ticket.id);
      io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'system' });
      io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
      return res.status(409).json({ error: 'Topic deleted' });
    }
  }

  io.to(`ticket:${ticket.id}`).emit('ticket_reopened');
  io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'open' });
  io.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  res.json({ ok: true });
});

// ─── PUSH NOTIFICATIONS ──────────────────────────────────────────────────────

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

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

const welcomeSent = new Set();
const messageRates = new Map();
const warnedTickets = new Set();

const SUPPORT_NAME = 'Поддержка KV9RU';
const WELCOME_1 = 'Добро пожаловать в службу поддержки KV9RU! 👋';
const WELCOME_2 = 'Чтобы мы могли быстрее разобраться и решить вашу проблему — пожалуйста, прикрепите скриншот из приложения VPN и опишите проблему максимально подробно 📸';

function isRateLimited(sessionToken) {
  const now = Date.now();
  let rate = messageRates.get(sessionToken);
  if (!rate || now > rate.resetAt) {
    rate = { count: 0, resetAt: now + 60000 };
  }
  rate.count++;
  messageRates.set(sessionToken, rate);
  return rate.count > 20;
}

function scheduleWelcomeMessages(ticketId) {
  if (welcomeSent.has(ticketId)) return;
  if (db.getMessages.all(ticketId).length > 0) return;

  welcomeSent.add(ticketId);

  const sendMsg = (content, delayMs) => setTimeout(() => {
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;

    const id = uuidv4();
    const created_at = new Date().toISOString();
    db.saveMessage.run(id, ticketId, 'support', SUPPORT_NAME, content, 'text', null, null, null, null, null);
    io.to(`ticket:${ticketId}`).emit('message', {
      id, ticket_id: ticketId,
      sender: 'support', sender_name: SUPPORT_NAME,
      content, message_type: 'text',
      file_url: null, file_name: null, file_mime: null,
      created_at
    });
  }, delayMs);

  sendMsg(WELCOME_1, 1200);
  sendMsg(WELCOME_2, 2800);
}

// Broadcast updated ticket list to all admins
function broadcastAdminTickets() {
  io.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
}

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  // ── USER HANDLERS ────────────────────────────────────────────────────────

  socket.on('join_ticket', ({ ticketId, sessionToken }) => {
    const ticket = db.getTicketBySessionAny.get(sessionToken);
    if (!ticket || ticket.id !== ticketId) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    socket.join(`ticket:${ticketId}`);
    socket.ticketId = ticketId;
    console.log(`[Socket] ${socket.id} joined ticket:${ticketId}`);
    scheduleWelcomeMessages(ticketId);
  });

  socket.on('typing', () => {
    if (!socket.ticketId) return;
    const ticket = db.getTicketById.get(socket.ticketId);
    if (!ticket || ticket.status === 'closed') return;
    telegram.sendTyping(ticket).catch(() => {});
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
      if (!content && !fileUrl) {
        if (ack) ack({ error: 'Empty message' });
        return;
      }
      if (isRateLimited(sessionToken)) {
        if (ack) ack({ error: 'Rate limit' });
        return;
      }

      warnedTickets.delete(ticket.id);

      const msgId = uuidv4();
      const msgType = messageType || 'text';

      db.saveMessage.run(
        msgId, ticketId,
        'user', ticket.user_name,
        content || null, msgType,
        fileUrl || null, fileName || null, fileMime || null,
        null, null
      );

      const message = {
        id: msgId, ticket_id: ticketId,
        sender: 'user', sender_name: ticket.user_name,
        content: content || null, message_type: msgType,
        file_url: fileUrl || null, file_name: fileName || null, file_mime: fileMime || null,
        created_at: new Date().toISOString()
      };

      io.to(`ticket:${ticketId}`).emit('message', message);
      io.to('admin').emit('admin_new_message', { ticketId, message });
      broadcastAdminTickets();

      telegram.forwardMessage(ticket, message).catch(e => console.error('[TG] forwardMessage:', e?.message));

      if (ack) ack({ ok: true, id: msgId });
    } catch (err) {
      console.error('[Socket] send_message error:', err);
      if (ack) ack({ error: 'Server error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected:', socket.id);
  });

  // ── ADMIN HANDLERS ───────────────────────────────────────────────────────

  socket.on('admin_auth', ({ token }) => {
    if (!ADMIN_TOKEN || !token || token !== ADMIN_TOKEN) {
      socket.emit('admin_auth_error', { message: 'Invalid token' });
      return;
    }
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
    // Notify user their messages were read
    io.to(`ticket:${ticketId}`).emit('messages_read');
    socket.emit('admin_ticket_messages', { ticketId, messages, ticket });
    // Refresh ticket list (unread count reset)
    broadcastAdminTickets();
  });

  socket.on('admin_reply', async ({ ticketId, content }) => {
    if (!socket.isAdmin) return;
    const text = (content || '').trim();
    if (!text) return;
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;

    const msgId = uuidv4();
    db.saveMessage.run(msgId, ticketId, 'support', SUPPORT_NAME, text, 'text', null, null, null, null, null);
    db.markSupportRead.run(ticketId);

    const message = {
      id: msgId, ticket_id: ticketId,
      sender: 'support', sender_name: SUPPORT_NAME,
      content: text, message_type: 'text',
      file_url: null, file_name: null, file_mime: null,
      created_at: new Date().toISOString()
    };

    io.to(`ticket:${ticketId}`).emit('message', message);
    io.to('admin').emit('admin_new_message', { ticketId, message });
    broadcastAdminTickets();

    push.send(ticketId, text).catch(() => {});
    const freshTicket = db.getTicketById.get(ticketId);
    telegram.forwardMessage(freshTicket, message).catch(e => console.error('[Admin] forwardMessage:', e?.message));
  });

  socket.on('admin_typing', ({ ticketId }) => {
    if (!socket.isAdmin) return;
    // Send to user sockets in the ticket room (admin sockets are not in ticket rooms)
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
    if (ticket.telegram_topic_deleted) {
      socket.emit('admin_error', { message: 'Тема удалена — создайте новый тикет' });
      return;
    }
    db.reopenTicket.run(ticket.id);
    try {
      await telegram.notifyTicketReopened(ticket);
    } catch (e) {
      if (e.topicDeleted) {
        db.closeTicket.run(ticket.id);
        socket.emit('admin_error', { message: 'Тема удалена — создайте новый тикет' });
        broadcastAdminTickets();
        return;
      }
    }
    io.to(`ticket:${ticketId}`).emit('ticket_reopened');
    socket.emit('admin_ticket_status', { ticketId, status: 'open' });
    broadcastAdminTickets();
  });
});

// ─── INACTIVITY AUTO-CLOSE ──────────────────────────────────────────────────

const staleTicketsQuery = db.db.prepare(`
  SELECT t.* FROM tickets t
  LEFT JOIN (
    SELECT ticket_id, MAX(created_at) AS last_msg FROM messages GROUP BY ticket_id
  ) m ON m.ticket_id = t.id
  WHERE t.status = 'open'
  AND COALESCE(m.last_msg, t.created_at) < datetime('now', '-1 hour')
`);

const warnTicketsQuery = db.db.prepare(`
  SELECT t.* FROM tickets t
  LEFT JOIN (
    SELECT ticket_id, MAX(created_at) AS last_msg FROM messages GROUP BY ticket_id
  ) m ON m.ticket_id = t.id
  WHERE t.status = 'open'
  AND COALESCE(m.last_msg, t.created_at) < datetime('now', '-45 minutes')
  AND COALESCE(m.last_msg, t.created_at) >= datetime('now', '-60 minutes')
`);

let _inactivityRunning = false;
async function inactivityCheck() {
  if (_inactivityRunning) return;
  _inactivityRunning = true;
  try {
    const toWarn = warnTicketsQuery.all();
    for (const ticket of toWarn) {
      if (warnedTickets.has(ticket.id)) continue;
      warnedTickets.add(ticket.id);

      const msgId = uuidv4();
      const created_at = new Date().toISOString();
      const content = 'Нет активности 45 минут — обращение будет закрыто через 15 минут.';
      db.saveMessage.run(msgId, ticket.id, 'system', 'Система', content, 'text', null, null, null, null, null);
      io.to(`ticket:${ticket.id}`).emit('message', {
        id: msgId, ticket_id: ticket.id,
        sender: 'system', sender_name: 'Система',
        content, message_type: 'text',
        file_url: null, file_name: null, file_mime: null,
        created_at
      });
      telegram.warnInactivity(ticket).catch(() => {});
    }

    const stale = staleTicketsQuery.all();
    for (const ticket of stale) {
      db.closeTicket.run(ticket.id);
      warnedTickets.delete(ticket.id);

      const msgId = uuidv4();
      const created_at = new Date().toISOString();
      const content = 'Обращение закрыто автоматически — нет активности в течение 1 часа.';
      db.saveMessage.run(msgId, ticket.id, 'system', 'Система', content, 'text', null, null, null, null, null);

      io.to(`ticket:${ticket.id}`).emit('message', {
        id: msgId, ticket_id: ticket.id,
        sender: 'system', sender_name: 'Система',
        content, message_type: 'text',
        file_url: null, file_name: null, file_mime: null,
        created_at
      });
      io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'inactivity' });
      io.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });

      telegram.autoCloseTicket(ticket).catch(() => {});
      console.log(`[Auto] Closed inactive ticket ${ticket.id.slice(0, 8)}`);
    }

    if (stale.length > 0) broadcastAdminTickets();
  } catch (e) { console.error('[Auto] inactivityCheck:', e.message); }
  finally { _inactivityRunning = false; }
}

setInterval(inactivityCheck, 60 * 1000);

app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});
