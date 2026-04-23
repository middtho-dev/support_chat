require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cookieParser = require('cookie-parser');

const db = require('./database');
const telegram = require('./telegram');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
  maxHttpBufferSize: 50 * 1024 * 1024
});

telegram.init(io);

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

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mime = file.mimetype;
    const ok = mime.startsWith('image/') || mime.startsWith('video/') ||
                mime.startsWith('audio/') || ALLOWED_MIMES.has(mime);
    ok ? cb(null, true) : cb(new Error('File type not allowed'));
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());
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
  telegram.createTopic(ticketId, name).catch(() => {});

  res.json({ sessionToken, ticketId, userName: name });
});

app.post('/api/session/resume', (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken || typeof sessionToken !== 'string') {
    return res.status(400).json({ error: 'Token required' });
  }

  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket) return res.status(404).json({ error: 'No active ticket' });

  const messages = db.getMessages.all(ticket.id);
  res.json({ ticket, messages });
});

app.get('/api/tickets/:ticketId/messages', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const messages = db.getMessages.all(ticket.id);
  res.json(messages);
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });

  const mime = req.file.mimetype;
  let type = 'file';
  if (mime.startsWith('image/')) type = 'image';
  else if (mime.startsWith('video/')) type = 'video';
  else if (mime.startsWith('audio/')) type = 'audio';

  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    mime,
    type
  });
});

app.post('/api/tickets/:ticketId/close', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  db.closeTicket.run(ticket.id);
  telegram.notifyTicketClosed(ticket).catch(() => {});
  io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'user' });

  res.json({ ok: true });
});

app.post('/api/tickets/:ticketId/reopen', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  db.reopenTicket.run(ticket.id);
  telegram.notifyTicketReopened(ticket).catch(() => {});
  io.to(`ticket:${ticket.id}`).emit('ticket_reopened');

  res.json({ ok: true });
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

// Tracks tickets that already had welcome messages scheduled this session
const welcomeSent = new Set();

const SUPPORT_NAME = 'Поддержка KV9RU';
const WELCOME_1 = 'Добро пожаловать в службу поддержки KV9RU! 👋';
const WELCOME_2 = 'Чтобы мы могли быстрее разобраться и решить вашу проблему — пожалуйста, прикрепите скриншот из приложения VPN и опишите проблему максимально подробно 📸';

function scheduleWelcomeMessages(ticketId) {
  if (welcomeSent.has(ticketId)) return;
  if (db.getMessages.all(ticketId).length > 0) return;

  welcomeSent.add(ticketId);

  const sendMsg = (content, delayMs) => setTimeout(() => {
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status === 'closed') return;

    const id = uuidv4();
    const created_at = new Date().toISOString();
    db.saveMessage.run(id, ticketId, 'support', SUPPORT_NAME, content, 'text', null, null, null, null);
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

io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

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

      const msgId = uuidv4();
      const msgType = messageType || 'text';

      db.saveMessage.run(
        msgId, ticketId,
        'user', ticket.user_name,
        content || null, msgType,
        fileUrl || null, fileName || null, fileMime || null,
        null
      );

      const message = {
        id: msgId, ticket_id: ticketId,
        sender: 'user', sender_name: ticket.user_name,
        content: content || null, message_type: msgType,
        file_url: fileUrl || null, file_name: fileName || null, file_mime: fileMime || null,
        created_at: new Date().toISOString()
      };

      io.to(`ticket:${ticketId}`).emit('message', message);
      telegram.forwardMessage(ticket, message).catch(() => {});

      if (ack) ack({ ok: true, id: msgId });
    } catch (err) {
      console.error('[Socket] send_message error:', err);
      if (ack) ack({ error: 'Server error' });
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected:', socket.id);
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

async function inactivityCheck() {
  try {
    const stale = staleTicketsQuery.all();
    for (const ticket of stale) {
      db.closeTicket.run(ticket.id);

      const msgId = uuidv4();
      const created_at = new Date().toISOString();
      const content = 'Обращение закрыто автоматически — нет активности в течение 1 часа.';
      db.saveMessage.run(msgId, ticket.id, 'system', 'Система', content, 'text', null, null, null, null);

      io.to(`ticket:${ticket.id}`).emit('message', {
        id: msgId, ticket_id: ticket.id,
        sender: 'system', sender_name: 'Система',
        content, message_type: 'text',
        file_url: null, file_name: null, file_mime: null,
        created_at
      });
      io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'inactivity' });

      telegram.autoCloseTicket(ticket).catch(() => {});
      console.log(`[Auto] Closed inactive ticket ${ticket.id.slice(0, 8)}`);
    }
  } catch (e) { console.error('[Auto] inactivityCheck:', e.message); }
}

setInterval(inactivityCheck, 60 * 1000);

// Health check
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});
