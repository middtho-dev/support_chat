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
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024 // 50MB
});

// Init telegram bot with socket reference
telegram.init(io);

// Uploads directory
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /image|video|audio|pdf|text|application\/(pdf|msword|zip|x-zip)/;
    if (allowed.test(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../public')));

// ─── REST API ────────────────────────────────────────────────────────────────

// Start session / resume session
app.post('/api/session/start', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 1) {
    return res.status(400).json({ error: 'Name required' });
  }

  const sessionToken = uuidv4();
  const ticketId = uuidv4();

  db.createTicket.run(ticketId, name.trim(), sessionToken);

  // Create Telegram topic (async, don't wait)
  telegram.createTopic(ticketId, name.trim()).catch(() => {});

  res.json({ sessionToken, ticketId, userName: name.trim() });
});

// Resume existing session
app.post('/api/session/resume', (req, res) => {
  const { sessionToken } = req.body;
  if (!sessionToken) return res.status(400).json({ error: 'Token required' });

  const ticket = db.getTicketBySessionAny.get(sessionToken);
  if (!ticket) return res.status(404).json({ error: 'No active ticket' });

  const messages = db.getMessages.all(ticket.id);
  res.json({ ticket, messages });
});

// Get messages for ticket
app.get('/api/tickets/:ticketId/messages', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  const messages = db.getMessages.all(ticket.id);
  res.json(messages);
});

// Upload file
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

// Close ticket (by user)
app.post('/api/tickets/:ticketId/close', (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  db.closeTicket.run(ticket.id);
  telegram.notifyTicketClosed(ticket).catch(() => {});

  // Notify other sockets in this room
  io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'user' });

  res.json({ ok: true });
});

// Reopen ticket
app.post("/api/tickets/:ticketId/reopen", (req, res) => {
  const ticket = db.getTicketById.get(req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: "Not found" });
  db.db.prepare("UPDATE tickets SET status='open', closed_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(ticket.id);
  telegram.notifyTicketReopened(ticket).catch(() => {});
  io.to("ticket:"+ticket.id).emit("ticket_reopened");
  res.json({ ok: true });
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────

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
        msgId,
        ticketId,
        'user',
        ticket.user_name,
        content || null,
        msgType,
        fileUrl || null,
        fileName || null,
        fileMime || null,
        null
      );

      const message = {
        id: msgId,
        ticket_id: ticketId,
        sender: 'user',
        sender_name: ticket.user_name,
        content: content || null,
        message_type: msgType,
        file_url: fileUrl || null,
        file_name: fileName || null,
        file_mime: fileMime || null,
        created_at: new Date().toISOString()
      };

      // Broadcast to room (for multi-tab support)
      io.to(`ticket:${ticketId}`).emit('message', message);

      // Forward to Telegram (async)
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

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// ─── START ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
});
