const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const db = require('./database');
const push = require('./push');
const { v4: uuidv4 } = require('uuid');
const { loadSettings, formatTemplate } = require('./settings');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;

let bot = null;
let io = null;
let reconnectTimer = null;
let connected = false;
const topicStatus = new Map();
const DISPLAY_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

function cfg() { return loadSettings(); }
function tgEnabled() { const s = cfg(); return s.telegramEnabled && !!bot && !!GROUP_ID; }
function kbClose(tid) { return { inline_keyboard: [[{ text: cfg().telegramCloseButtonText, callback_data: `close:${tid}` }]] }; }
function kbReopen(tid) { return { inline_keyboard: [[{ text: cfg().telegramReopenButtonText, callback_data: `reopen:${tid}` }]] }; }
function shortId(ticket) { return String(ticket?.id || '').slice(0, 8); }
function mdEscape(value) { return String(value ?? '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }
function values(ticket, extra = {}) {
  const date = ticket?.created_at ? new Date(ticket.created_at) : new Date();
  return {
    name: ticket?.user_name || '',
    nameMd: mdEscape(ticket?.user_name || ''),
    shortId: shortId(ticket),
    date: date.toLocaleDateString('ru-RU'),
    dateTime: new Date().toLocaleString('ru-RU'),
    ...extra
  };
}
function topicName(ticket, emoji) {
  return formatTemplate(cfg().telegramTopicNameTemplate, { ...values(ticket), emoji }).slice(0, 128);
}

function isThreadNotFound(e) {
  const msg = String(e?.message || e?.response?.body?.description || '').toLowerCase();
  return msg.includes('thread not found') || msg.includes('topic_deleted') || msg.includes('topic_closed') || msg.includes('chat not found');
}

function publicUploadPath(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
  let relative;
  try {
    relative = path.normalize(decodeURIComponent(fileUrl).replace(/^\/+/, ''));
  } catch {
    return null;
  }
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const fp = path.resolve(__dirname, '../public', relative);
  const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads'));
  if (fp !== uploadsDir && !fp.startsWith(uploadsDir + path.sep)) return null;
  return fp;
}

async function sendWithDocumentFallback(sendPrimary, fp, opts) {
  try {
    return await sendPrimary();
  } catch (e) {
    const msg = String(e?.message || e?.response?.body?.description || '').toLowerCase();
    if (msg.includes('wrong file identifier') || msg.includes('photo_invalid') || msg.includes('failed to get http url content') || msg.includes('bad request')) {
      return bot.sendDocument(GROUP_ID, fp, opts);
    }
    throw e;
  }
}

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
    bot = new TelegramBot(TOKEN, { polling: { interval: 2000, autoStart: false, params: { timeout: 30 } } });
    bot.on('polling_error', err => { if (connected) { connected = false; console.error('[TG] Lost:', err.message); } scheduleReconnect(); });
    bot.on('error', err => { console.error('[TG] Error:', err.message); scheduleReconnect(); });
    bot.on('message', async msg => { if (!connected) { connected = true; console.log('[TG] Connected ✓'); } await handleMessage(msg); });
    bot.on('callback_query', async query => { if (!connected) { connected = true; console.log('[TG] Connected ✓'); } await handleCallbackQuery(query); });
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
    if (!tgEnabled()) return;
    await bot.answerCallbackQuery(query.id).catch(() => {});
    if (String(query.message?.chat?.id) !== String(GROUP_ID)) return;
    const topicId = query.message?.message_thread_id;
    if (!topicId) return;
    const data = query.data || '';

    if (data.startsWith('close:')) {
      const ticket = db.getTicketByTopicIdAny.get(topicId);
      if (!ticket) return;
      if (ticket.status === 'closed') return safeSend(GROUP_ID, '⚠️ Тикет уже закрыт', { message_thread_id: topicId });
      await closeTicketFromTelegram(ticket, topicId);
    } else if (data.startsWith('reopen:')) {
      const ticket = db.getTicketByTopicIdAny.get(topicId);
      if (!ticket) return;
      if (ticket.status !== 'closed') return safeSend(GROUP_ID, '⚠️ Тикет уже открыт', { message_thread_id: topicId });
      await reopenTicketFromTelegram(ticket, topicId);
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
    if (!tgEnabled()) return;
    const s = cfg();
    if (String(msg.chat.id) !== String(GROUP_ID)) return;
    const topicId = msg.message_thread_id;

    if (msg.forum_topic_edited && topicId) {
      if (s.telegramDeleteRenameNotices) {
        try { await bot.deleteMessage(GROUP_ID, msg.message_id); }
        catch (e) { console.error('[TG] Delete rename notice failed:', e.message); }
      }
      return;
    }

    if (!topicId || (msg.from && msg.from.is_bot)) return;
    const ticket = db.getTicketByTopicIdAny.get(topicId);
    if (!ticket) return;
    const rawText = msg.text || msg.caption || null;
    const cmd = parseCmd(rawText);

    if (cmd === '/close') {
      if (ticket.status === 'closed') return safeSend(GROUP_ID, '⚠️ Тикет уже закрыт. /reopen — переоткрыть', { message_thread_id: topicId });
      await closeTicketFromTelegram(ticket, topicId);
      return;
    }

    if (cmd === '/reopen') {
      if (ticket.status !== 'closed') return safeSend(GROUP_ID, '⚠️ Тикет уже открыт', { message_thread_id: topicId });
      await reopenTicketFromTelegram(ticket, topicId);
      return;
    }

    if (ticket.status === 'closed') {
      await safeSend(GROUP_ID, '⚠️ Тикет закрыт. /reopen — переоткрыть', { message_thread_id: topicId });
      return;
    }

    if (!s.telegramForwardOperatorMessages) return;

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
        replyToId = replyMsg.id;
        replyToContent = replyMsg.content;
        replyToSenderName = replyMsg.sender_name;
        replyToType = replyMsg.message_type;
        replyToFileName = replyMsg.file_name;
      }
    }

    const id = uuidv4();
    const senderName = msg.from.first_name || s.supportName || 'Support';
    db.saveMessage.run(id, ticket.id, 'support', senderName, rawText, type, fileUrl, fileName, fileMime, msg.message_id, replyToId);

    io?.to(`ticket:${ticket.id}`).emit('message', {
      id, ticket_id: ticket.id, sender: 'support', sender_name: senderName,
      content: rawText, message_type: type, file_url: fileUrl, file_name: fileName, file_mime: fileMime,
      created_at: new Date().toISOString(), reply_to_id: replyToId || null,
      reply_to_content: replyToContent || null, reply_to_sender_name: replyToSenderName || null,
      reply_to_type: replyToType || null, reply_to_file_name: replyToFileName || null
    });
    push.send(ticket.id, rawText || 'Новое сообщение').catch(() => {});
  } catch (e) { console.error('[TG] handleMessage:', e.message); }
}

async function closeTicketFromTelegram(ticket, topicId) {
  const s = cfg();
  db.closeTicket.run(ticket.id);
  io?.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'support' });
  io?.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  await setTopicStatus(topicId, ticket, s.telegramClosedEmoji);
  await safeSend(GROUP_ID, s.telegramClosedBySupportText, { message_thread_id: topicId, reply_markup: kbReopen(topicId) });
  if (s.telegramCloseTopicOnClose) await bot.closeForumTopic(GROUP_ID, topicId).catch(() => {});
}

async function reopenTicketFromTelegram(ticket, topicId) {
  const s = cfg();
  db.reopenTicket.run(ticket.id);
  if (s.telegramReopenTopicOnReopen) await bot.reopenForumTopic(GROUP_ID, topicId).catch(() => {});
  topicStatus.delete(topicId);
  await setTopicStatus(topicId, ticket, s.telegramWaitEmoji);
  await safeSend(GROUP_ID, s.telegramReopenedText, { message_thread_id: topicId, reply_markup: kbClose(topicId) });
  io?.to(`ticket:${ticket.id}`).emit('ticket_reopened');
  io?.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'open' });
}

async function setTopicStatus(topicId, ticket, emoji) {
  if (!tgEnabled()) return;
  try {
    const t = db.getTicketById.get(typeof ticket === 'string' ? ticket : ticket.id);
    if (!t) return;
    const name = topicName(t, emoji);
    if (topicStatus.get(topicId) === name) return;
    await bot.editForumTopic(GROUP_ID, topicId, { name });
    topicStatus.set(topicId, name);
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
      fileId = msg.video.file_id; fileName = msg.video.file_name || `video_${Date.now()}.mp4`; fileMime = msg.video.mime_type || 'video/mp4'; type = 'video';
    } else if (msg.document) {
      fileId = msg.document.file_id; fileName = msg.document.file_name || `file_${Date.now()}`; fileMime = msg.document.mime_type || 'application/octet-stream';
      const ext = path.extname(fileName).toLowerCase();
      type = fileMime.startsWith('image/') && DISPLAY_IMAGE_EXTS.has(ext) ? 'image' : fileMime.startsWith('video/') ? 'video' : 'file';
    } else if (msg.voice) {
      fileId = msg.voice.file_id; fileName = `voice_${Date.now()}.ogg`; fileMime = 'audio/ogg'; type = 'audio';
    }
    if (!fileId) return null;
    const link = await bot.getFileLink(fileId);
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 30000);
    let resp;
    try { resp = await fetch(link, { signal: controller.signal }); }
    finally { clearTimeout(fetchTimeout); }
    if (!resp.ok) throw new Error('fetch failed');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > cfg().uploadMaxMb * 1024 * 1024) throw new Error('File too large');
    const dir = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const safe = `tg_${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await fsp.writeFile(path.join(dir, safe), buf);
    return { url: `/uploads/${safe}`, name: fileName, mime: fileMime, type };
  } catch (e) { console.error('[TG] downloadFile:', e.message); return null; }
}

async function safeSend(chatId, text, opts = {}) {
  if (!tgEnabled() || !String(text || '').trim()) return null;
  try { return await bot.sendMessage(chatId, text, opts); }
  catch (e) {
    console.error('[TG] safeSend:', e.message);
    if (opts.message_thread_id && isThreadNotFound(e)) {
      const ticket = db.getTicketByTopicIdAny.get(opts.message_thread_id);
      if (ticket) db.markTopicDeleted.run(ticket.id);
    }
    return null;
  }
}

async function createTopic(ticketId, userName) {
  const s = cfg();
  if (!tgEnabled() || !s.telegramCreateTopics) return null;
  try {
    const fakeTicket = { id: ticketId, user_name: userName, created_at: new Date().toISOString() };
    const topic = await bot.createForumTopic(GROUP_ID, topicName(fakeTicket, s.telegramNewEmoji));
    const topicId = topic.message_thread_id;
    db.setTopicId.run(topicId, ticketId);
    topicStatus.set(topicId, topicName(fakeTicket, s.telegramNewEmoji));
    const text = formatTemplate(s.telegramNewTicketText, { ...values(fakeTicket), name: mdEscape(userName), shortId: ticketId.slice(0, 8) });
    const infoMsg = await safeSend(GROUP_ID, text, { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: kbClose(topicId) });
    if (infoMsg && s.telegramPinNewTicketMessage) await bot.pinChatMessage(GROUP_ID, infoMsg.message_id, { message_thread_id: topicId }).catch(() => {});
    return topicId;
  } catch (e) { console.error('[TG] createTopic:', e.message); return null; }
}

async function forwardMessage(ticket, message) {
  const s = cfg();
  if (!tgEnabled() || !ticket?.telegram_topic_id) return;
  if (message.sender === 'user' && !s.telegramForwardUserMessages) return;
  if (message.sender === 'support' && !s.telegramForwardAdminMessages) return;
  const tid = ticket.telegram_topic_id;
  try {
    let sent;
    const fp = publicUploadPath(message.file_url);
    if (message.message_type === 'text') sent = await bot.sendMessage(GROUP_ID, message.content, { message_thread_id: tid });
    else if (message.message_type === 'image' && fp) sent = await sendWithDocumentFallback(
      () => bot.sendPhoto(GROUP_ID, fp, { message_thread_id: tid, caption: message.content || undefined }),
      fp,
      { message_thread_id: tid, caption: message.content || undefined }
    );
    else if (message.message_type === 'video' && fp) sent = await sendWithDocumentFallback(
      () => bot.sendVideo(GROUP_ID, fp, { message_thread_id: tid, caption: message.content || undefined }),
      fp,
      { message_thread_id: tid, caption: message.content || undefined }
    );
    else if (message.message_type === 'audio' && fp) sent = await sendWithDocumentFallback(
      () => bot.sendVoice(GROUP_ID, fp, { message_thread_id: tid }),
      fp,
      { message_thread_id: tid, caption: message.content || undefined }
    );
    else if (fp) sent = await bot.sendDocument(GROUP_ID, fp, { message_thread_id: tid, caption: message.content || undefined });
    if (sent) db.updateTelegramMessageId.run(sent.message_id, message.id);
    await setTopicStatus(tid, ticket, message.sender === 'user' ? s.telegramWaitEmoji : s.telegramOpenEmoji);
  } catch (e) {
    if (isThreadNotFound(e)) db.markTopicDeleted.run(ticket.id);
    else console.error('[TG] forwardMessage:', e.message);
  }
}

async function notifyTicketClosed(ticket) {
  const s = cfg();
  if (!tgEnabled() || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    await setTopicStatus(tid, ticket, s.telegramClosedEmoji);
    await safeSend(GROUP_ID, s.telegramClosedByUserText, { message_thread_id: tid, reply_markup: kbReopen(tid) });
    if (s.telegramCloseTopicOnClose) await bot.closeForumTopic(GROUP_ID, tid).catch(() => {});
  } catch (e) { console.error('[TG] notifyTicketClosed:', e.message); }
}

async function notifyTicketReopened(ticket) {
  const s = cfg();
  if (!tgEnabled() || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    if (s.telegramReopenTopicOnReopen) {
      try { await bot.reopenForumTopic(GROUP_ID, tid); }
      catch (reopenErr) {
        if (isThreadNotFound(reopenErr)) {
          db.markTopicDeleted.run(ticket.id);
          const err = new Error('Telegram topic deleted');
          err.topicDeleted = true;
          throw err;
        }
      }
    }
    topicStatus.delete(tid);
    await setTopicStatus(tid, ticket, s.telegramWaitEmoji);
    await safeSend(GROUP_ID, s.telegramReopenedByUserText, { message_thread_id: tid, reply_markup: kbClose(tid) });
  } catch (e) { if (e.topicDeleted) throw e; console.error('[TG] notifyTicketReopened:', e.message); }
}

async function autoCloseTicket(ticket, extra = {}) {
  const s = cfg();
  if (!tgEnabled() || !ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    topicStatus.delete(tid);
    await setTopicStatus(tid, ticket, s.telegramClosedEmoji);
    await safeSend(GROUP_ID, formatTemplate(s.telegramAutoCloseText, { ...values(ticket), ...extra }), { message_thread_id: tid, reply_markup: kbReopen(tid) });
    if (s.telegramCloseTopicOnClose) await bot.closeForumTopic(GROUP_ID, tid).catch(() => {});
  } catch (e) { console.error('[TG] autoCloseTicket:', e.message); }
}

async function warnInactivity(ticket, extra = {}) {
  const s = cfg();
  if (!tgEnabled() || !ticket.telegram_topic_id) return;
  try {
    await safeSend(GROUP_ID, formatTemplate(s.telegramWarnInactivityText, { ...values(ticket), ...extra }), { message_thread_id: ticket.telegram_topic_id });
  } catch (e) { console.error('[TG] warnInactivity:', e.message); }
}

async function sendTyping(ticket) {
  if (!tgEnabled() || !ticket.telegram_topic_id) return;
  try { await bot.sendChatAction(GROUP_ID, 'typing', { message_thread_id: ticket.telegram_topic_id }); } catch {}
}

async function checkTopicAlive(ticket) {
  if (!tgEnabled()) return true;
  if (!ticket.telegram_topic_id) return false;
  try {
    await bot.sendChatAction(GROUP_ID, 'typing', { message_thread_id: ticket.telegram_topic_id });
    return true;
  } catch (e) {
    const msg = String(e?.message || e?.response?.body?.description || '').toLowerCase();
    const gone = msg.includes('thread not found') || msg.includes('topic_deleted');
    if (gone) { try { db.markTopicDeleted.run(ticket.id); } catch {} return false; }
    return true;
  }
}

async function cleanupOldTopics() {
  const s = cfg();
  if (!tgEnabled() || !s.telegramCleanupClosedTopics) return;
  try {
    const cutoff = new Date(Date.now() - s.telegramCleanupClosedHours * 60 * 60 * 1000).toISOString();
    const rows = db.db.prepare(`SELECT * FROM tickets WHERE status='closed' AND closed_at < ? AND telegram_topic_id IS NOT NULL`).all(cutoff);
    for (const t of rows) {
      try {
        await bot.deleteForumTopic(GROUP_ID, t.telegram_topic_id);
        db.db.prepare(`UPDATE tickets SET telegram_topic_id=NULL WHERE id=?`).run(t.id);
        topicStatus.delete(t.telegram_topic_id);
        console.log(`[TG] Cleaned topic ${shortId(t)}`);
      } catch {}
      await new Promise(r => setTimeout(r, 600));
    }
  } catch (e) { console.error('[TG] cleanup:', e.message); }
}

module.exports = { init, createTopic, forwardMessage, notifyTicketClosed, notifyTicketReopened, autoCloseTicket, sendTyping, warnInactivity, checkTopicAlive };
