const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { v4: uuidv4 } = require('uuid');

const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;

let bot            = null;
let io             = null;
let reconnectTimer = null;
let connected      = false;

const E_OPEN   = '🟢';
const E_CLOSED = '🔴';
const E_WAIT   = '🟡';

const topicStatus = new Map();

const kbClose  = tid => ({ inline_keyboard: [[{ text: '🔴 Закрыть тикет', callback_data: `close:${tid}`  }]] });
const kbReopen = tid => ({ inline_keyboard: [[{ text: '🟢 Переоткрыть',   callback_data: `reopen:${tid}` }]] });

function init(socketIo) {
  io = socketIo;
  if (!TOKEN || !GROUP_ID) {
    console.warn('[TG] BOT_TOKEN / GROUP_ID not set — disabled');
    return null;
  }
  startBot();
  setInterval(cleanupOldTopics, 60 * 60 * 1000);
  return bot;
}

function startBot() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  console.log('[TG] Starting...');
  try {
    bot = new TelegramBot(TOKEN, {
      polling: { interval: 2000, autoStart: false, params: { timeout: 30 } }
    });
    bot.on('polling_error', err => {
      if (connected) { connected = false; console.error('[TG] Lost:', err.message); }
      scheduleReconnect();
    });
    bot.on('error', err => { console.error('[TG] Error:', err.message); scheduleReconnect(); });
    bot.on('message', async msg => {
      if (!connected) { connected = true; console.log('[TG] Connected ✓'); }
      await handleMessage(msg);
    });
    bot.on('callback_query', async query => {
      if (!connected) { connected = true; console.log('[TG] Connected ✓'); }
      await handleCallbackQuery(query);
    });
    bot.startPolling();
  } catch (e) {
    console.error('[TG] Failed to start:', e.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      if (bot) bot.stopPolling().catch(() => {}).finally(() => { bot = null; startBot(); });
      else startBot();
    } catch { bot = null; startBot(); }
  }, 5000);
}

async function handleCallbackQuery(query) {
  try {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    if (String(query.message?.chat?.id) !== String(GROUP_ID)) return;
    const topicId = query.message?.message_thread_id;
    if (!topicId) return;
    const data = query.data || '';

    if (data.startsWith('close:')) {
      const ticket = db.getTicketByTopicIdAny.get(topicId);
      if (!ticket) return;
      if (ticket.status === 'closed') {
        await safeSend(GROUP_ID, '⚠️ Тикет уже закрыт', { message_thread_id: topicId });
        return;
      }
      await closeTicketFromTelegram(ticket, topicId);
    } else if (data.startsWith('reopen:')) {
      const ticket = db.getTicketByTopicIdAny.get(topicId);
      if (!ticket) return;
      if (ticket.status !== 'closed') {
        await safeSend(GROUP_ID, '⚠️ Тикет уже открыт', { message_thread_id: topicId });
        return;
      }
      db.reopenTicket.run(ticket.id);
      try { await bot.reopenForumTopic(GROUP_ID, topicId); } catch {}
      topicStatus.delete(topicId);
      await setTopicStatus(topicId, ticket, E_OPEN);
      await safeSend(GROUP_ID, '🟢 Тикет переоткрыт', {
        message_thread_id: topicId,
        reply_markup: kbClose(topicId)
      });
      if (io) io.to(`ticket:${ticket.id}`).emit('ticket_reopened');
    }
  } catch (e) { console.error('[TG] handleCallbackQuery:', e.message); }
}

function parseCmd(text) {
  if (!text) return null;
  const match = text.trim().toLowerCase().match(/^(\/\w+)(?:@\w+)?/);
  return match ? match[1] : null;
}

async function handleMessage(msg) {
  try {
    if (String(msg.chat.id) !== String(GROUP_ID)) return;
    const topicId = msg.message_thread_id;

    if (msg.forum_topic_edited && topicId) {
      try { await bot.deleteMessage(GROUP_ID, msg.message_id); }
      catch (e) { console.error('[TG] Delete rename notice failed (needs can_delete_messages):', e.message); }
      return;
    }

    if (!topicId || (msg.from && msg.from.is_bot)) return;

    const ticket = db.getTicketByTopicIdAny.get(topicId);
    if (!ticket) return;

    const rawText = msg.text || msg.caption || null;
    const cmd = parseCmd(rawText);

    if (cmd === '/close') {
      if (ticket.status === 'closed') {
        await safeSend(GROUP_ID, '⚠️ Тикет уже закрыт. /reopen — переоткрыть', { message_thread_id: topicId });
        return;
      }
      await closeTicketFromTelegram(ticket, topicId);
      return;
    }

    if (cmd === '/reopen') {
      if (ticket.status !== 'closed') {
        await safeSend(GROUP_ID, '⚠️ Тикет уже открыт', { message_thread_id: topicId });
        return;
      }
      db.reopenTicket.run(ticket.id);
      try { await bot.reopenForumTopic(GROUP_ID, topicId); } catch {}
      topicStatus.delete(topicId);
      await setTopicStatus(topicId, ticket, E_OPEN);
      await safeSend(GROUP_ID, '🟢 Тикет переоткрыт', {
        message_thread_id: topicId,
        reply_markup: kbClose(topicId)
      });
      if (io) io.to(`ticket:${ticket.id}`).emit('ticket_reopened');
      return;
    }

    if (ticket.status === 'closed') {
      await safeSend(GROUP_ID, '⚠️ Тикет закрыт. /reopen — переоткрыть', { message_thread_id: topicId });
      return;
    }

    // Regular message from operator
    let type = 'text', fileUrl = null, fileName = null, fileMime = null;
    if (msg.photo || msg.video || msg.document || msg.voice) {
      const f = await downloadFile(msg);
      if (f) { fileUrl = f.url; fileName = f.name; fileMime = f.mime; type = f.type; }
    }
    if (!rawText && !fileUrl) return;

    let replyToId = null, replyToContent = null, replyToSenderName = null, replyToType = null, replyToFileName = null;
    if (msg.reply_to_message) {
      const replyMsg = db.getMessageByTelegramId.get(msg.reply_to_message.message_id);
      if (replyMsg) {
        replyToId         = replyMsg.id;
        replyToContent    = replyMsg.content;
        replyToSenderName = replyMsg.sender_name;
        replyToType       = replyMsg.message_type;
        replyToFileName   = replyMsg.file_name;
      }
    }

    const id = uuidv4();
    db.saveMessage.run(
      id, ticket.id, 'support', msg.from.first_name || 'Support',
      rawText, type, fileUrl, fileName, fileMime, msg.message_id, replyToId
    );

    if (io) {
      io.to(`ticket:${ticket.id}`).emit('message', {
        id, ticket_id: ticket.id,
        sender: 'support',
        sender_name: msg.from.first_name || 'Support',
        content: rawText, message_type: type,
        file_url: fileUrl, file_name: fileName, file_mime: fileMime,
        created_at: new Date().toISOString(),
        reply_to_id:          replyToId          || null,
        reply_to_content:     replyToContent     || null,
        reply_to_sender_name: replyToSenderName  || null,
        reply_to_type:        replyToType        || null,
        reply_to_file_name:   replyToFileName    || null,
      });
    }
  } catch (e) { console.error('[TG] handleMessage:', e.message); }
}

async function closeTicketFromTelegram(ticket, topicId) {
  db.closeTicket.run(ticket.id);
  if (io) io.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'support' });
  await setTopicStatus(topicId, ticket, E_CLOSED);
  await safeSend(GROUP_ID, '🔴 Тикет закрыт', {
    message_thread_id: topicId,
    reply_markup: kbReopen(topicId)
  });
  try { await bot.closeForumTopic(GROUP_ID, topicId); } catch {}
}

async function setTopicStatus(topicId, ticket, emoji) {
  if (!bot || !GROUP_ID) return;
  const current = topicStatus.get(topicId);
  if (current === emoji) return;
  try {
    const t = db.getTicketById.get(typeof ticket === 'string' ? ticket : ticket.id);
    if (!t) return;
    const date = new Date(t.created_at).toLocaleDateString('ru-RU');
    const name = `${emoji} ${t.user_name} • ${date}`;
    await bot.editForumTopic(GROUP_ID, topicId, { name });
    topicStatus.set(topicId, emoji);
    console.log(`[TG] Topic → ${name}`);
  } catch (e) { console.error('[TG] setTopicStatus:', e.message); }
}

async function downloadFile(msg) {
  try {
    let fileId, fileName, fileMime, type;
    if (msg.photo) {
      const p = msg.photo[msg.photo.length - 1];
      fileId = p.file_id; fileName = `photo_${Date.now()}.jpg`; fileMime = 'image/jpeg'; type = 'image';
    } else if (msg.video) {
      fileId = msg.video.file_id; fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
      fileMime = msg.video.mime_type || 'video/mp4'; type = 'video';
    } else if (msg.document) {
      fileId = msg.document.file_id; fileName = msg.document.file_name || `file_${Date.now()}`;
      fileMime = msg.document.mime_type || 'application/octet-stream';
      type = fileMime.startsWith('image/') ? 'image' : fileMime.startsWith('video/') ? 'video' : 'file';
    } else if (msg.voice) {
      fileId = msg.voice.file_id; fileName = `voice_${Date.now()}.ogg`; fileMime = 'audio/ogg'; type = 'audio';
    }
    if (!fileId) return null;
    const link = await bot.getFileLink(fileId);
    const resp = await fetch(link);
    if (!resp.ok) throw new Error('fetch failed');
    const buf = Buffer.from(await resp.arrayBuffer());
    const dir = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = `tg_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.writeFileSync(path.join(dir, safe), buf);
    return { url: `/uploads/${safe}`, name: fileName, mime: fileMime, type };
  } catch (e) { console.error('[TG] downloadFile:', e.message); return null; }
}

async function safeSend(chatId, text, opts = {}) {
  try { return bot ? await bot.sendMessage(chatId, text, opts) : null; }
  catch (e) { console.error('[TG] safeSend:', e.message); return null; }
}

async function createTopic(ticketId, userName) {
  if (!bot || !GROUP_ID) return null;
  try {
    const date = new Date().toLocaleDateString('ru-RU');
    const name = `${E_OPEN} ${userName} • ${date}`;
    const topic = await bot.createForumTopic(GROUP_ID, name);
    const topicId = topic.message_thread_id;
    db.setTopicId.run(topicId, ticketId);
    topicStatus.set(topicId, E_OPEN);
    const infoMsg = await safeSend(GROUP_ID,
      `🎫 *Новое обращение*\n👤 *${userName}*\n🆔 \`${ticketId.slice(0,8)}\`\n📅 ${new Date().toLocaleString('ru-RU')}`,
      { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: kbClose(topicId) }
    );
    if (infoMsg) {
      try { await bot.pinChatMessage(GROUP_ID, infoMsg.message_id, { message_thread_id: topicId }); } catch {}
    }
    return topicId;
  } catch (e) { console.error('[TG] createTopic:', e.message); return null; }
}

async function forwardMessage(ticket, message) {
  if (!bot || !GROUP_ID || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    let sent;
    const fp = message.file_url ? path.join(__dirname, '../public', message.file_url) : null;
    if (message.message_type === 'text') {
      sent = await bot.sendMessage(GROUP_ID, message.content, { message_thread_id: tid });
    } else if (message.message_type === 'image' && fp) {
      sent = await bot.sendPhoto(GROUP_ID, fp, { message_thread_id: tid, caption: message.content || undefined });
    } else if (message.message_type === 'video' && fp) {
      sent = await bot.sendVideo(GROUP_ID, fp, { message_thread_id: tid, caption: message.content || undefined });
    } else if (message.message_type === 'audio' && fp) {
      sent = await bot.sendVoice(GROUP_ID, fp, { message_thread_id: tid });
    } else if (fp) {
      sent = await bot.sendDocument(GROUP_ID, fp, { message_thread_id: tid, caption: message.content || undefined });
    }
    if (sent) db.updateTelegramMessageId.run(sent.message_id, message.id);
    await setTopicStatus(tid, ticket, E_WAIT);
  } catch (e) { console.error('[TG] forwardMessage:', e.message); }
}

async function notifyTicketClosed(ticket) {
  if (!bot || !GROUP_ID || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    await setTopicStatus(tid, ticket, E_CLOSED);
    await safeSend(GROUP_ID, '🔴 Закрыто пользователем', {
      message_thread_id: tid,
      reply_markup: kbReopen(tid)
    });
    await bot.closeForumTopic(GROUP_ID, tid);
  } catch (e) { console.error('[TG] notifyTicketClosed:', e.message); }
}

async function notifyTicketReopened(ticket) {
  if (!bot || !GROUP_ID || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    await bot.reopenForumTopic(GROUP_ID, tid).catch(() => {});
    topicStatus.delete(tid);
    await setTopicStatus(tid, ticket, E_OPEN);
    await safeSend(GROUP_ID, '🟢 Переоткрыто пользователем', {
      message_thread_id: tid,
      reply_markup: kbClose(tid)
    });
  } catch (e) { console.error('[TG] notifyTicketReopened:', e.message); }
}

async function autoCloseTicket(ticket) {
  if (!bot || !GROUP_ID || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    await setTopicStatus(tid, ticket, E_CLOSED);
    await safeSend(GROUP_ID,
      '⏱ Тикет закрыт автоматически — нет активности 1 час',
      { message_thread_id: tid, reply_markup: kbReopen(tid) }
    );
    await bot.closeForumTopic(GROUP_ID, tid).catch(() => {});
  } catch (e) { console.error('[TG] autoCloseTicket:', e.message); }
}

async function warnInactivity(ticket) {
  if (!bot || !GROUP_ID || !ticket.telegram_topic_id) return;
  try {
    await safeSend(GROUP_ID,
      '⚠️ Нет активности 45 минут — тикет будет закрыт через 15 минут',
      { message_thread_id: ticket.telegram_topic_id }
    );
  } catch (e) { console.error('[TG] warnInactivity:', e.message); }
}

async function sendTyping(ticket) {
  if (!bot || !GROUP_ID || !ticket.telegram_topic_id) return;
  try {
    await bot.sendChatAction(GROUP_ID, 'typing', { message_thread_id: ticket.telegram_topic_id });
  } catch {}
}

async function cleanupOldTopics() {
  if (!bot || !GROUP_ID) return;
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.db.prepare(
      `SELECT * FROM tickets WHERE status='closed' AND closed_at < ? AND telegram_topic_id IS NOT NULL`
    ).all(cutoff);
    for (const t of rows) {
      try {
        await bot.deleteForumTopic(GROUP_ID, t.telegram_topic_id);
        db.db.prepare(`UPDATE tickets SET telegram_topic_id=NULL WHERE id=?`).run(t.id);
        topicStatus.delete(t.telegram_topic_id);
        console.log(`[TG] Cleaned topic ${t.id.slice(0,8)}`);
      } catch {}
      await new Promise(r => setTimeout(r, 600));
    }
  } catch (e) { console.error('[TG] cleanup:', e.message); }
}

module.exports = { init, createTopic, forwardMessage, notifyTicketClosed, notifyTicketReopened, autoCloseTicket, sendTyping, warnInactivity };
