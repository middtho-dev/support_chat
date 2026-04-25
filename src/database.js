const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/support.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    session_token TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'open',
    telegram_topic_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    content TEXT,
    message_type TEXT DEFAULT 'text',
    file_url TEXT,
    file_name TEXT,
    file_mime TEXT,
    telegram_message_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ticket_id) REFERENCES tickets(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_session ON tickets(session_token);
  CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
`);

// Migration: add reply_to_id column if not exists
try { db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT`); } catch {}

// Push subscriptions
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

module.exports = {
  // Tickets
  createTicket: db.prepare(`
    INSERT INTO tickets (id, user_name, session_token, status)
    VALUES (?, ?, ?, 'open')
  `),

  getTicketBySessionAny: db.prepare(`SELECT * FROM tickets WHERE session_token = ?`),
  getTicketBySession:    db.prepare(`SELECT * FROM tickets WHERE session_token = ? AND status = 'open'`),
  getTicketById:         db.prepare(`SELECT * FROM tickets WHERE id = ?`),

  setTopicId:   db.prepare(`UPDATE tickets SET telegram_topic_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
  closeTicket:  db.prepare(`UPDATE tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
  reopenTicket: db.prepare(`UPDATE tickets SET status = 'open', closed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),

  // Returns only open tickets (for forwarding messages)
  getTicketByTopicId:    db.prepare(`SELECT * FROM tickets WHERE telegram_topic_id = ? AND status = 'open'`),
  // Returns ticket regardless of status (for handling /close, /reopen commands)
  getTicketByTopicIdAny: db.prepare(`SELECT * FROM tickets WHERE telegram_topic_id = ?`),

  getAllOpenTickets: db.prepare(`SELECT * FROM tickets WHERE status = 'open' ORDER BY updated_at DESC`),

  // Messages
  saveMessage: db.prepare(`
    INSERT INTO messages
      (id, ticket_id, sender, sender_name, content, message_type, file_url, file_name, file_mime, telegram_message_id, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  // JOIN to bring reply content alongside each message
  getMessages: db.prepare(`
    SELECT m.*,
      r.content      AS reply_to_content,
      r.sender_name  AS reply_to_sender_name,
      r.message_type AS reply_to_type,
      r.file_name    AS reply_to_file_name
    FROM messages m
    LEFT JOIN messages r ON r.id = m.reply_to_id
    WHERE m.ticket_id = ? ORDER BY m.created_at ASC
  `),

  getMessageByTelegramId: db.prepare(`SELECT * FROM messages WHERE telegram_message_id = ?`),

  updateTelegramMessageId: db.prepare(`UPDATE messages SET telegram_message_id = ? WHERE id = ?`),

  // Push subscriptions
  savePushSub: db.prepare(`INSERT OR REPLACE INTO push_subscriptions (id, ticket_id, subscription) VALUES (?, ?, ?)`),
  getPushSubs: db.prepare(`SELECT * FROM push_subscriptions WHERE ticket_id = ?`),
  delPushSub:  db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`),

  db
};
