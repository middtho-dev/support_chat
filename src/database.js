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

  CREATE INDEX IF NOT EXISTS idx_messages_ticket   ON messages(ticket_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_tg_id    ON messages(telegram_message_id);
  CREATE INDEX IF NOT EXISTS idx_messages_ticket_created ON messages(ticket_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_tickets_session   ON tickets(session_token);
  CREATE INDEX IF NOT EXISTS idx_tickets_status    ON tickets(status);
  CREATE INDEX IF NOT EXISTS idx_tickets_created   ON tickets(created_at);
`);

// Migration: add reply_to_id column if not exists
try { db.exec(`ALTER TABLE messages ADD COLUMN reply_to_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN is_auto INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '[]'`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_attempts INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_last_error TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_next_retry_at DATETIME`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_chat_id TEXT`); } catch {}

// Migrations: admin + topic tracking
try { db.exec(`ALTER TABLE tickets ADD COLUMN support_read_at DATETIME`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_topic_deleted INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN admin_tags TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN admin_note TEXT DEFAULT ''`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN assigned_operator_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_last_reminded_at DATETIME`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN source TEXT DEFAULT 'web'`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_chat_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_username TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_first_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_last_name TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_language_code TEXT`); } catch {}
try { db.exec(`ALTER TABLE tickets ADD COLUMN telegram_customer_control_message_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE telegram_operators ADD COLUMN can_manage_settings INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_source_chat_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_source_message_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_customer_message_id INTEGER`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_customer_attempts INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_customer_last_error TEXT`); } catch {}
try { db.exec(`ALTER TABLE messages ADD COLUMN telegram_customer_next_retry_at DATETIME`); } catch {}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_tickets_telegram_customer
    ON tickets(telegram_customer_id, status, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_open_telegram_customer
    ON tickets(telegram_customer_id)
    WHERE status = 'open' AND telegram_customer_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_telegram_source
    ON messages(telegram_source_chat_id, telegram_source_message_id)
    WHERE telegram_source_chat_id IS NOT NULL AND telegram_source_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_messages_customer_delivery
    ON messages(telegram_customer_message_id, telegram_customer_next_retry_at, created_at);
`);

// Only one process may consume getUpdates for a bot token. Keeping the lease in
// the shared application database also covers overlapping containers during a
// rolling restart, while allowing a standby process to take over after expiry.
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_runtime_leases (
    name TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Private Telegram operator inbox. A private topic id is scoped to its chat, so
// never store or look it up without the operator chat id.
db.exec(`
  CREATE TABLE IF NOT EXISTS telegram_operators (
    telegram_user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    username TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    can_manage_settings INTEGER NOT NULL DEFAULT 0,
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS telegram_ticket_threads (
    ticket_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    thread_id INTEGER NOT NULL,
    root_message_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticket_id, operator_id),
    UNIQUE (chat_id, thread_id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (operator_id) REFERENCES telegram_operators(telegram_user_id)
  );

  CREATE TABLE IF NOT EXISTS telegram_customer_chat_messages (
    ticket_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS telegram_ticket_notifications (
    ticket_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (ticket_id, operator_id),
    UNIQUE (chat_id, message_id),
    FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    FOREIGN KEY (operator_id) REFERENCES telegram_operators(telegram_user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_tg_destination
    ON messages(telegram_chat_id, telegram_message_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_threads_destination
    ON telegram_ticket_threads(chat_id, thread_id);
  CREATE INDEX IF NOT EXISTS idx_ticket_threads_status
    ON telegram_ticket_threads(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_ticket_notifications_destination
    ON telegram_ticket_notifications(chat_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_assigned_operator
    ON tickets(assigned_operator_id, status);
  CREATE INDEX IF NOT EXISTS idx_messages_pending_telegram
    ON messages(telegram_message_id, telegram_next_retry_at, created_at);
`);

// Push subscriptions
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  subscription TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_push_ticket ON push_subscriptions(ticket_id)`);
db.exec(`
  DELETE FROM push_subscriptions
  WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM push_subscriptions GROUP BY ticket_id, subscription
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_push_ticket_subscription
  ON push_subscriptions(ticket_id, subscription);
`);

// Runtime settings
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
const defaultSettings = {
  timezone: 'Europe/Moscow',
  work_start_hour: '8',
  work_end_hour: '23',
  offhours_enabled: '1',
  offhours_banner_text: 'Сейчас нерабочее время (МСК). Ответим в рабочее время, но сообщение можно оставить сейчас.',
  offhours_reject_text: 'Сейчас нерабочее время. Ответим в рабочее время, но сообщение можно оставить сейчас.'
};
const insertDefaultSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
for (const [k, v] of Object.entries(defaultSettings)) {
  insertDefaultSetting.run(k, v);
}

module.exports = {
  // Tickets
  createTicket: db.prepare(`
    INSERT INTO tickets (id, user_name, session_token, status)
    VALUES (?, ?, ?, 'open')
  `),
  createTelegramTicket: db.prepare(`
    INSERT INTO tickets (
      id, user_name, session_token, status, source,
      telegram_customer_id, telegram_customer_chat_id,
      telegram_customer_username, telegram_customer_first_name,
      telegram_customer_last_name, telegram_customer_language_code
    )
    VALUES (?, ?, ?, 'open', 'telegram', ?, ?, ?, ?, ?, ?)
  `),
  getOpenTicketByTelegramCustomer: db.prepare(`
    SELECT * FROM tickets
    WHERE telegram_customer_id = ? AND status = 'open'
    ORDER BY updated_at DESC LIMIT 1
  `),
  getLatestTicketByTelegramCustomer: db.prepare(`
    SELECT * FROM tickets
    WHERE telegram_customer_id = ?
    ORDER BY updated_at DESC LIMIT 1
  `),
  updateTelegramCustomerProfile: db.prepare(`
    UPDATE tickets SET
      user_name = ?,
      telegram_customer_chat_id = ?,
      telegram_customer_username = ?,
      telegram_customer_first_name = ?,
      telegram_customer_last_name = ?,
      telegram_customer_language_code = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_customer_id = ? AND status = 'open'
  `),
  setTelegramCustomerControlMessage: db.prepare(`
    UPDATE tickets SET telegram_customer_control_message_id = ? WHERE id = ?
  `),
  clearTelegramCustomerControlMessage: db.prepare(`
    UPDATE tickets SET telegram_customer_control_message_id = NULL
    WHERE id = ? AND telegram_customer_control_message_id = ?
  `),
  trackTelegramCustomerChatMessage: db.prepare(`
    INSERT OR IGNORE INTO telegram_customer_chat_messages
      (ticket_id, chat_id, message_id)
    VALUES (?, ?, ?)
  `),
  getTelegramCustomerChatMessages: db.prepare(`
    SELECT message_id FROM telegram_customer_chat_messages
    WHERE ticket_id = ?
  `),
  clearTelegramCustomerChatMessages: db.prepare(`
    DELETE FROM telegram_customer_chat_messages WHERE ticket_id = ?
  `),

  getTicketBySessionAny: db.prepare(`SELECT * FROM tickets WHERE session_token = ?`),
  getTicketBySession:    db.prepare(`SELECT * FROM tickets WHERE session_token = ? AND status = 'open'`),
  getTicketById: db.prepare(`
    SELECT t.*, op.display_name AS assigned_operator_name,
      op.username AS assigned_operator_username
    FROM tickets t
    LEFT JOIN telegram_operators op
      ON op.telegram_user_id = t.assigned_operator_id
    WHERE t.id = ?
  `),

  setTopicId:   db.prepare(`UPDATE tickets SET telegram_topic_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
  closeTicket:  db.prepare(`UPDATE tickets SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
  reopenTicket: db.prepare(`UPDATE tickets SET status = 'open', closed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),

  // Returns only open tickets (for forwarding messages)
  getTicketByTopicId:    db.prepare(`SELECT * FROM tickets WHERE telegram_topic_id = ? AND status = 'open'`),
  // Returns ticket regardless of status (for handling /close, /reopen commands)
  getTicketByTopicIdAny: db.prepare(`SELECT * FROM tickets WHERE telegram_topic_id = ?`),

  getAllOpenTickets: db.prepare(`SELECT * FROM tickets WHERE status = 'open' ORDER BY updated_at DESC`),
  getOpenUnassignedTickets: db.prepare(`
    SELECT * FROM tickets
    WHERE status = 'open' AND assigned_operator_id IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `),
  countOpenUnassignedTickets: db.prepare(`
    SELECT COUNT(*) AS count FROM tickets
    WHERE status = 'open' AND assigned_operator_id IS NULL
  `),
  getOpenUnassignedTicketsPage: db.prepare(`
    SELECT t.*,
      m.content AS last_msg,
      m.message_type AS last_msg_type,
      m.file_name AS last_file_name,
      COALESCE(m.created_at, t.created_at) AS last_activity
    FROM tickets t
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages
      WHERE ticket_id = t.id
      ORDER BY created_at DESC LIMIT 1
    )
    WHERE t.status = 'open' AND t.assigned_operator_id IS NULL
    ORDER BY last_activity DESC
    LIMIT ? OFFSET ?
  `),
  countOpenTicketsForOperator: db.prepare(`
    SELECT COUNT(*) AS count FROM tickets
    WHERE status = 'open' AND assigned_operator_id = ?
  `),
  getOpenTicketsForOperator: db.prepare(`
    SELECT t.*,
      m.content AS last_msg,
      m.message_type AS last_msg_type,
      m.file_name AS last_file_name,
      COALESCE(m.created_at, t.created_at) AS last_activity
    FROM tickets t
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages
      WHERE ticket_id = t.id
      ORDER BY created_at DESC LIMIT 1
    )
    WHERE t.status = 'open' AND t.assigned_operator_id = ?
    ORDER BY last_activity DESC
    LIMIT ? OFFSET ?
  `),
  countClosedTicketsForOperator: db.prepare(`
    SELECT COUNT(*) AS count FROM tickets
    WHERE status = 'closed' AND assigned_operator_id = ?
  `),
  getClosedTicketsForOperator: db.prepare(`
    SELECT t.*,
      m.content AS last_msg,
      m.message_type AS last_msg_type,
      m.file_name AS last_file_name,
      COALESCE(m.created_at, t.created_at) AS last_activity
    FROM tickets t
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages
      WHERE ticket_id = t.id
      ORDER BY created_at DESC LIMIT 1
    )
    WHERE t.status = 'closed' AND t.assigned_operator_id = ?
    ORDER BY COALESCE(t.closed_at, m.created_at, t.created_at) DESC
    LIMIT ? OFFSET ?
  `),
  assignTicketIfUnassigned: db.prepare(`
    UPDATE tickets
    SET assigned_operator_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open' AND assigned_operator_id IS NULL
  `),
  assignTicket: db.prepare(`
    UPDATE tickets SET assigned_operator_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  unassignTicket: db.prepare(`
    UPDATE tickets SET assigned_operator_id = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `),
  getOpenTicketsWithoutTelegramTopic: db.prepare(`
    SELECT * FROM tickets
    WHERE status = 'open'
      AND telegram_topic_id IS NULL
      AND COALESCE(telegram_topic_deleted, 0) = 0
    ORDER BY created_at ASC
    LIMIT ?
  `),
  getOpenAssignedTicketsWithoutPrivateThread: db.prepare(`
    SELECT t.*
    FROM tickets t
    WHERE t.status = 'open'
      AND t.assigned_operator_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM telegram_ticket_threads th
        WHERE th.ticket_id = t.id
          AND th.operator_id = t.assigned_operator_id
          AND th.status = 'active'
      )
    ORDER BY t.created_at ASC
    LIMIT ?
  `),
  getTicketsAwaitingTelegramReminder: db.prepare(`
    WITH awaiting AS (
      SELECT t.*,
        COALESCE((
          SELECT m.created_at
          FROM messages m
          WHERE m.ticket_id = t.id
            AND m.sender != 'system'
            AND COALESCE(m.is_auto, 0) = 0
          ORDER BY m.created_at DESC, m.rowid DESC
          LIMIT 1
        ), t.created_at) AS waiting_since,
        COALESCE((
          SELECT m.sender
          FROM messages m
          WHERE m.ticket_id = t.id
            AND m.sender != 'system'
            AND COALESCE(m.is_auto, 0) = 0
          ORDER BY m.created_at DESC, m.rowid DESC
          LIMIT 1
        ), 'user') AS last_conversation_sender
      FROM tickets t
      WHERE t.status = 'open'
    )
    SELECT *
    FROM awaiting
    WHERE last_conversation_sender = 'user'
      AND waiting_since <= datetime('now', ?)
      AND (
        telegram_last_reminded_at IS NULL
        OR telegram_last_reminded_at < waiting_since
        OR telegram_last_reminded_at <= datetime('now', ?)
      )
    ORDER BY waiting_since ASC
    LIMIT ?
  `),
  markTelegramTicketReminded: db.prepare(`
    UPDATE tickets
    SET telegram_last_reminded_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `),

  // Messages
  saveMessage: db.prepare(`
    INSERT INTO messages
      (id, ticket_id, sender, sender_name, content, message_type, file_url, file_name, file_mime, telegram_message_id, reply_to_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  saveAutoMessage: db.prepare(`
    INSERT INTO messages
      (id, ticket_id, sender, sender_name, content, message_type, file_url, file_name, file_mime, telegram_message_id, reply_to_id, is_auto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
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

  // Returns last N messages (ASC order) — for initial load with pagination
  getMessagesRecent: db.prepare(`
    SELECT * FROM (
      SELECT m.*,
        r.content      AS reply_to_content,
        r.sender_name  AS reply_to_sender_name,
        r.message_type AS reply_to_type,
        r.file_name    AS reply_to_file_name
      FROM messages m
      LEFT JOIN messages r ON r.id = m.reply_to_id
      WHERE m.ticket_id = ? ORDER BY m.created_at DESC LIMIT ?
    ) ORDER BY created_at ASC
  `),

  // Returns N messages strictly before a timestamp (ASC order) — "load older"
  getMessagesBefore: db.prepare(`
    SELECT * FROM (
      SELECT m.*,
        r.content      AS reply_to_content,
        r.sender_name  AS reply_to_sender_name,
        r.message_type AS reply_to_type,
        r.file_name    AS reply_to_file_name
      FROM messages m
      LEFT JOIN messages r ON r.id = m.reply_to_id
      WHERE m.ticket_id = ? AND m.created_at < ? ORDER BY m.created_at DESC LIMIT ?
    ) ORDER BY created_at ASC
  `),

  countMessages: db.prepare(`SELECT COUNT(*) AS cnt FROM messages WHERE ticket_id = ?`),

  getUnsentMessagesForTelegram: db.prepare(`
    SELECT * FROM messages
    WHERE ticket_id = ?
      AND sender != 'system'
      AND COALESCE(is_auto, 0) = 0
      AND telegram_message_id IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `),

  getMessageByTelegramId: db.prepare(`SELECT * FROM messages WHERE telegram_message_id = ?`),
  getMessageByTelegramDestination: db.prepare(`
    SELECT * FROM messages
    WHERE telegram_chat_id = ? AND telegram_message_id = ?
  `),
  getMessageByTelegramSource: db.prepare(`
    SELECT * FROM messages
    WHERE telegram_source_chat_id = ? AND telegram_source_message_id = ?
  `),
  getMessageByTelegramCustomerDelivery: db.prepare(`
    SELECT * FROM messages
    WHERE ticket_id = ? AND telegram_customer_message_id = ?
  `),
  setTelegramMessageSource: db.prepare(`
    UPDATE messages
    SET telegram_source_chat_id = ?, telegram_source_message_id = ?
    WHERE id = ?
  `),

  getMessageById: db.prepare(`SELECT * FROM messages WHERE id = ?`),

  getPendingTelegramMessages: db.prepare(`
    SELECT m.*, t.user_name, t.status AS ticket_status, t.telegram_topic_id,
      t.telegram_topic_deleted
    FROM messages m
    JOIN tickets t ON t.id = m.ticket_id
    WHERE m.sender != 'system'
      AND COALESCE(m.is_auto, 0) = 0
      AND m.telegram_message_id IS NULL
      AND COALESCE(t.telegram_topic_deleted, 0) = 0
      AND (m.telegram_next_retry_at IS NULL OR m.telegram_next_retry_at <= CURRENT_TIMESTAMP)
    ORDER BY m.created_at ASC
    LIMIT ?
  `),
  getPendingPrivateTelegramMessages: db.prepare(`
    SELECT m.*, t.user_name, t.status AS ticket_status, t.telegram_topic_id,
      t.telegram_topic_deleted
    FROM messages m
    JOIN tickets t ON t.id = m.ticket_id
    WHERE m.sender != 'system'
      AND COALESCE(m.is_auto, 0) = 0
      AND m.telegram_message_id IS NULL
      AND t.status = 'open'
      AND t.assigned_operator_id IS NOT NULL
      AND (m.telegram_next_retry_at IS NULL OR m.telegram_next_retry_at <= CURRENT_TIMESTAMP)
    ORDER BY m.created_at ASC
    LIMIT ?
  `),

  updateTelegramMessageId: db.prepare(`
    UPDATE messages SET telegram_message_id = ?, telegram_last_error = NULL,
      telegram_next_retry_at = NULL WHERE id = ?
  `),
  updateTelegramDelivery: db.prepare(`
    UPDATE messages SET telegram_chat_id = ?, telegram_message_id = ?,
      telegram_last_error = NULL, telegram_next_retry_at = NULL
    WHERE id = ?
  `),
  markTelegramAttempt: db.prepare(`
    UPDATE messages SET telegram_attempts = COALESCE(telegram_attempts, 0) + 1,
      telegram_last_error = ?, telegram_next_retry_at = datetime('now', ?)
    WHERE id = ? AND telegram_message_id IS NULL
  `),
  getPendingTelegramCustomerReplies: db.prepare(`
    SELECT m.*, t.telegram_customer_chat_id, t.telegram_customer_id,
      t.status AS ticket_status, t.source AS ticket_source
    FROM messages m
    JOIN tickets t ON t.id = m.ticket_id
    WHERE m.sender = 'support'
      AND t.source = 'telegram'
      AND t.status = 'open'
      AND t.telegram_customer_chat_id IS NOT NULL
      AND m.telegram_customer_message_id IS NULL
      AND (m.telegram_customer_next_retry_at IS NULL
        OR m.telegram_customer_next_retry_at <= CURRENT_TIMESTAMP)
    ORDER BY m.created_at ASC
    LIMIT ?
  `),
  updateTelegramCustomerDelivery: db.prepare(`
    UPDATE messages SET
      telegram_customer_message_id = ?,
      telegram_customer_last_error = NULL,
      telegram_customer_next_retry_at = NULL
    WHERE id = ?
  `),
  markTelegramCustomerAttempt: db.prepare(`
    UPDATE messages SET
      telegram_customer_attempts = COALESCE(telegram_customer_attempts, 0) + 1,
      telegram_customer_last_error = ?,
      telegram_customer_next_retry_at = datetime('now', ?)
    WHERE id = ? AND telegram_customer_message_id IS NULL
  `),
  acquireTelegramRuntimeLease: db.prepare(`
    INSERT INTO telegram_runtime_leases (name, owner_id, expires_at, updated_at)
    VALUES (?, ?, datetime('now', ?), CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET
      owner_id = excluded.owner_id,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
    WHERE telegram_runtime_leases.owner_id = excluded.owner_id
       OR telegram_runtime_leases.expires_at <= CURRENT_TIMESTAMP
  `),
  renewTelegramRuntimeLease: db.prepare(`
    UPDATE telegram_runtime_leases
    SET expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
    WHERE name = ? AND owner_id = ?
  `),
  releaseTelegramRuntimeLease: db.prepare(`
    DELETE FROM telegram_runtime_leases WHERE name = ? AND owner_id = ?
  `),
  getTelegramRuntimeLease: db.prepare(`
    SELECT * FROM telegram_runtime_leases WHERE name = ?
  `),
  updateMessageReactions: db.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`),

  // Telegram private operators, assignment cards, and per-operator topics
  upsertTelegramOperator: db.prepare(`
    INSERT INTO telegram_operators
      (telegram_user_id, display_name, username, active, last_seen_at)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      username = excluded.username,
      active = 1,
      last_seen_at = CURRENT_TIMESTAMP
  `),
  touchTelegramOperator: db.prepare(`
    UPDATE telegram_operators SET last_seen_at = CURRENT_TIMESTAMP
    WHERE telegram_user_id = ?
  `),
  getTelegramOperator: db.prepare(`
    SELECT * FROM telegram_operators WHERE telegram_user_id = ?
  `),
  getActiveTelegramOperators: db.prepare(`
    SELECT * FROM telegram_operators WHERE active = 1
    ORDER BY registered_at ASC
  `),
  listTelegramOperators: db.prepare(`
    SELECT * FROM telegram_operators
    ORDER BY active DESC, registered_at ASC
  `),
  saveManagedTelegramOperator: db.prepare(`
    INSERT INTO telegram_operators
      (telegram_user_id, display_name, username, active, can_manage_settings)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      display_name = excluded.display_name,
      username = excluded.username,
      active = excluded.active,
      can_manage_settings = excluded.can_manage_settings
  `),
  deactivateTelegramOperator: db.prepare(`
    UPDATE telegram_operators SET active = 0 WHERE telegram_user_id = ?
  `),
  saveTelegramThread: db.prepare(`
    INSERT INTO telegram_ticket_threads
      (ticket_id, operator_id, chat_id, thread_id, root_message_id, status)
    VALUES (?, ?, ?, ?, ?, 'active')
    ON CONFLICT(ticket_id, operator_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      thread_id = excluded.thread_id,
      root_message_id = excluded.root_message_id,
      status = 'active',
      updated_at = CURRENT_TIMESTAMP
  `),
  setTelegramThreadRoot: db.prepare(`
    UPDATE telegram_ticket_threads
    SET root_message_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE ticket_id = ? AND operator_id = ?
  `),
  getTelegramThreadForTicket: db.prepare(`
    SELECT th.*, op.display_name AS operator_name, op.username AS operator_username
    FROM telegram_ticket_threads th
    JOIN telegram_operators op ON op.telegram_user_id = th.operator_id
    WHERE th.ticket_id = ? AND th.status = 'active'
    ORDER BY th.updated_at DESC LIMIT 1
  `),
  getTelegramThreadForTicketOperator: db.prepare(`
    SELECT * FROM telegram_ticket_threads
    WHERE ticket_id = ? AND operator_id = ? AND status = 'active'
  `),
  getTelegramThreadForTicketOperatorAny: db.prepare(`
    SELECT * FROM telegram_ticket_threads
    WHERE ticket_id = ? AND operator_id = ?
  `),
  getTelegramThreadByDestination: db.prepare(`
    SELECT * FROM telegram_ticket_threads
    WHERE chat_id = ? AND thread_id = ? AND status = 'active'
  `),
  closeTelegramThreadsForTicket: db.prepare(`
    UPDATE telegram_ticket_threads
    SET status = 'closed', updated_at = CURRENT_TIMESTAMP
    WHERE ticket_id = ? AND status = 'active'
  `),
  reopenTelegramThread: db.prepare(`
    UPDATE telegram_ticket_threads
    SET status = 'active', updated_at = CURRENT_TIMESTAMP
    WHERE ticket_id = ? AND operator_id = ?
  `),
  deleteTelegramThread: db.prepare(`
    DELETE FROM telegram_ticket_threads WHERE ticket_id = ? AND operator_id = ?
  `),
  getClosedTelegramThreadsBefore: db.prepare(`
    SELECT th.*, t.user_name, t.closed_at
    FROM telegram_ticket_threads th
    JOIN tickets t ON t.id = th.ticket_id
    WHERE th.status = 'closed' AND t.closed_at IS NOT NULL AND t.closed_at < ?
    ORDER BY t.closed_at ASC
  `),
  saveTelegramNotification: db.prepare(`
    INSERT INTO telegram_ticket_notifications
      (ticket_id, operator_id, chat_id, message_id, state)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(ticket_id, operator_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      message_id = excluded.message_id,
      state = excluded.state,
      updated_at = CURRENT_TIMESTAMP
  `),
  getTelegramNotification: db.prepare(`
    SELECT * FROM telegram_ticket_notifications
    WHERE ticket_id = ? AND operator_id = ?
  `),
  getTelegramNotificationByDestination: db.prepare(`
    SELECT * FROM telegram_ticket_notifications
    WHERE chat_id = ? AND message_id = ?
  `),
  getTelegramNotificationsForTicket: db.prepare(`
    SELECT * FROM telegram_ticket_notifications WHERE ticket_id = ?
  `),
  updateTelegramNotificationState: db.prepare(`
    UPDATE telegram_ticket_notifications
    SET state = ?, updated_at = CURRENT_TIMESTAMP
    WHERE ticket_id = ?
  `),
  deleteTelegramNotificationsForTicket: db.prepare(`
    DELETE FROM telegram_ticket_notifications WHERE ticket_id = ?
  `),

  // Push subscriptions
  savePushSub: db.prepare(`
    INSERT INTO push_subscriptions (id, ticket_id, subscription)
    VALUES (?, ?, ?)
    ON CONFLICT(ticket_id, subscription)
    DO UPDATE SET created_at = CURRENT_TIMESTAMP
  `),
  getPushSubs: db.prepare(`SELECT * FROM push_subscriptions WHERE ticket_id = ?`),
  delPushSub:  db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`),

  // Telegram topic tracking
  markTopicDeleted: db.prepare(`UPDATE tickets SET telegram_topic_deleted = 1, telegram_topic_id = NULL WHERE id = ?`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),

  // Admin panel
  markSupportRead: db.prepare(`UPDATE tickets SET support_read_at = CURRENT_TIMESTAMP WHERE id = ?`),
  updateTicketMeta: db.prepare(`UPDATE tickets SET admin_tags = ?, admin_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`),
  getTicketsForAdmin: db.prepare(`
    SELECT t.*,
      op.display_name AS assigned_operator_name,
      op.username AS assigned_operator_username,
      m.content        AS last_msg,
      m.sender         AS last_sender,
      m.message_type   AS last_msg_type,
      COALESCE(m.created_at, t.created_at) AS last_activity,
      (SELECT COUNT(*) FROM messages
       WHERE ticket_id = t.id AND sender = 'user'
         AND created_at > COALESCE(t.support_read_at, '1970-01-01')) AS unread_count
    FROM tickets t
    LEFT JOIN telegram_operators op
      ON op.telegram_user_id = t.assigned_operator_id
    LEFT JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE ticket_id = t.id ORDER BY created_at DESC LIMIT 1
    )
    ORDER BY last_activity DESC
  `),

  db
};
