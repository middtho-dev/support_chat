const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const db = require('./database');
const push = require('./push');
const { loadSettings, formatTemplate } = require('./settings');
const { createTelegramPollingLease } = require('./telegram-lease');
const uuidv4 = () => crypto.randomUUID();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const WEBAPP_URL = adminWebAppUrl();
const TELEGRAM_ADMIN_IDS = new Set(String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(v => v.trim()).filter(Boolean));

let bot = null;
let io = null;
let connected = false;
let pollingLease = null;
const topicStatus = new Map();
const creatingTopics = new Map();
const DISPLAY_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
let cleanupTimer = null;
let deliveryTimer = null;
let deliveryRunning = false;
const forwardingMessages = new Set();
const incomingMessages = new Set();
const alertTimes = new Map();
const deliveryStats = { delivered: 0, failed: 0, retried: 0, incomingDuplicates: 0, mediaFailures: 0, lastError: null, lastSuccessAt: null };
const pollingStats = {
  conflicts: 0,
  lastConflictAt: null,
  lastConflict: null,
  consecutiveErrors: 0,
  lastError: null
};
const POLLING_ALERT_AFTER_ERRORS = 3;

function cfg() { return loadSettings(); }
function tgEnabled() { const s = cfg(); return s.telegramEnabled && !!bot && !!GROUP_ID && !!pollingLease?.isOwner(); }
function scheduleCleanupOldTopics(delayMs = 10000) {
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    cleanupOldTopics().catch(() => {});
  }, delayMs);
}
function tgButton(text, callbackData, style, customEmojiId) {
  const button = { text, callback_data: callbackData };
  if (style) button.style = style;
  if (customEmojiId) button.icon_custom_emoji_id = customEmojiId;
  return button;
}
function kbClose(tid) {
  const s = cfg();
  return { inline_keyboard: [[tgButton(s.telegramCloseButtonText, `close:${tid}`, s.telegramCloseButtonStyle, s.telegramCloseButtonEmojiId)]] };
}
function shortId(ticket) { return String(ticket?.id || '').slice(0, 8); }
function mdEscape(value) { return String(value ?? '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }
function htmlEscape(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch])); }
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

function singleChatMessage(ticket, message) {
  const isUser = message.sender === 'user';
  const title = isUser ? '💬 Новое сообщение клиента' : '↩️ Ответ из админки';
  const fileLabel = message.file_name ? `\nФайл: ${htmlEscape(message.file_name)}` : '';
  const body = message.content ? htmlEscape(message.content) : (message.file_name ? 'Файл без текста' : '');
  const details = [
    `Тикет: ${shortId(ticket)}`,
    `Клиент: ${ticket.user_name || ''}`,
    `Статус: ${ticket.status === 'closed' ? 'закрыт' : 'открыт'}`,
    `Создан: ${ticket.created_at ? new Date(ticket.created_at).toLocaleString('ru-RU') : 'неизвестно'}`,
    isUser ? 'Ответьте reply на это сообщение, чтобы написать пользователю.' : 'Сообщение отправлено из админки.'
  ].join('\n');
  return `${title}\n<b>${htmlEscape(ticket.user_name || 'Клиент')}</b> · <code>${htmlEscape(shortId(ticket))}</code><tg-spoiler>\n${htmlEscape(details)}${fileLabel}</tg-spoiler>${body ? `\n\n${body}` : ''}`;
}

function singleChatStatus(ticket, text) {
  const details = [
    `Тикет: ${shortId(ticket)}`,
    `Клиент: ${ticket?.user_name || ''}`,
    `Статус: ${ticket?.status === 'closed' ? 'закрыт' : 'открыт'}`,
    'В режиме единого чата отвечайте пользователю reply на его сообщение.'
  ].join('\n');
  return `${htmlEscape(text)}\n<tg-spoiler>${htmlEscape(details)}</tg-spoiler>`;
}

function isThreadNotFound(e) {
  const msg = String(e?.message || e?.response?.body?.description || '').toLowerCase();
  return msg.includes('thread not found') || msg.includes('topic_deleted') || msg.includes('topic_closed') || msg.includes('chat not found');
}

function tgError(e) {
  return String(e?.response?.body?.description || e?.message || e || 'unknown error');
}

function isPollingConflict(error) {
  const status = Number(error?.response?.statusCode || error?.response?.status || 0);
  const message = tgError(error).toLowerCase();
  return status === 409 || (
    message.includes('conflict') &&
    (message.includes('getupdates') || message.includes('get updates'))
  );
}

function reportPollingConflict(error) {
  const details = tgError(error);
  pollingStats.conflicts++;
  pollingStats.lastConflictAt = new Date().toISOString();
  pollingStats.lastConflict = details;
  console.error('[TG] Another getUpdates consumer is active; polling will retry automatically:', details);
  const key = 'telegram-polling-conflict';
  const now = Date.now();
  const cooldownMs = Number(cfg().operationalAlertCooldownMinutes || 15) * 60 * 1000;
  if (now - (alertTimes.get(key) || 0) < cooldownMs) return;
  alertTimes.set(key, now);
  io?.to('admin').emit('operational_alert', {
    key,
    message: 'Обнаружен второй экземпляр Telegram-бота',
    details: `${details}. Повторная попытка polling выполняется автоматически без Telegram-уведомления.`,
    createdAt: new Date().toISOString()
  });
}

function recordPollingError(error) {
  pollingStats.consecutiveErrors++;
  pollingStats.lastError = tgError(error);
  return pollingStats.consecutiveErrors >= POLLING_ALERT_AFTER_ERRORS;
}

function resetPollingErrors() {
  pollingStats.consecutiveErrors = 0;
}

function isDisposableTelegramServiceMessage(msg) {
  return !!(
    msg?.pinned_message ||
    msg?.forum_topic_edited ||
    msg?.forum_topic_closed ||
    msg?.forum_topic_reopened ||
    msg?.general_forum_topic_hidden ||
    msg?.general_forum_topic_unhidden ||
    msg?.message_auto_delete_timer_changed
  );
}

async function deleteTelegramServiceMessage(msg) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
      return;
    } catch (error) {
      const description = tgError(error).toLowerCase();
      if (description.includes('message to delete not found') ||
          description.includes('message_id_invalid')) {
        return;
      }
      if (attempt < 3) {
        await wait(150 * attempt);
        continue;
      }
      console.error('[TG] Delete service message failed:', tgError(error));
    }
  }
}

async function operationalAlert(key, text, details = '') {
  const settings = loadSettings();
  if (!settings.operationalAlertsEnabled) return;
  const now = Date.now();
  const cooldownMs = Number(settings.operationalAlertCooldownMinutes || 15) * 60 * 1000;
  if (now - (alertTimes.get(key) || 0) < cooldownMs) return;
  alertTimes.set(key, now);
  const message = `🚨 <b>Контроль доставки чата</b>\n${htmlEscape(text)}${details ? `\n<code>${htmlEscape(details).slice(0, 1500)}</code>` : ''}`;
  console.error(`[Monitor] ${text}`, details);
  io?.to('admin').emit('operational_alert', { key, message: text, details, createdAt: new Date().toISOString() });
  if (bot && GROUP_ID) {
    try { await bot.sendMessage(GROUP_ID, message, { parse_mode: 'HTML' }); } catch (e) { console.error('[Monitor] alert failed:', tgError(e)); }
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function adminWebAppUrl() {
  const explicit = process.env.TELEGRAM_WEBAPP_URL || process.env.ADMIN_WEBAPP_URL;
  if (explicit) return explicit;
  const base = process.env.PUBLIC_URL || process.env.APP_URL || process.env.BASE_URL;
  if (!base) return '';
  return `${String(base).replace(/\/+$/, '')}/miniapp`;
}

function adminWebAppUrlWithCacheBust() {
  if (!WEBAPP_URL) return '';
  const separator = WEBAPP_URL.includes('?') ? '&' : '?';
  return `${WEBAPP_URL}${separator}v=${Date.now().toString(36)}`;
}

function canOpenAdminWebApp(userId) {
  return TELEGRAM_ADMIN_IDS.size > 0 && TELEGRAM_ADMIN_IDS.has(String(userId || ''));
}

function adminWebAppKeyboard() {
  if (!WEBAPP_URL) return null;
  return {
    inline_keyboard: [[
      { text: 'Открыть админку', web_app: { url: adminWebAppUrlWithCacheBust() } }
    ]]
  };
}

async function announceAdminWebApp(topicId = null, from = null) {
  if (!canOpenAdminWebApp(from?.id)) {
    return safeSend(
      GROUP_ID,
      TELEGRAM_ADMIN_IDS.size
        ? 'Нет доступа к админке.'
        : 'Mini App закрыт: укажите TELEGRAM_ADMIN_IDS в .env.',
      topicId ? { message_thread_id: topicId } : {}
    );
  }
  if (!WEBAPP_URL) {
    return safeSend(
      GROUP_ID,
      'Mini App не настроен. Укажите TELEGRAM_WEBAPP_URL или PUBLIC_URL в .env и перезапустите приложение.',
      topicId ? { message_thread_id: topicId } : {}
    );
  }
  return safeSend(
    GROUP_ID,
    'Админка доступна как Telegram Mini App.',
    { ...(topicId ? { message_thread_id: topicId } : {}), reply_markup: adminWebAppKeyboard() }
  );
}

function publicUploadPath(fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string' || !fileUrl.startsWith('/uploads/')) return null;
  let relative;
  try {
    relative = decodeURIComponent(fileUrl.slice('/uploads/'.length));
  } catch {
    return null;
  }
  if (!relative || relative !== path.basename(relative) || relative.includes('\0')) return null;
  const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads'));
  const fp = path.resolve(uploadsDir, relative);
  if (!fp.startsWith(uploadsDir + path.sep)) return null;
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
  pollingLease = createTelegramPollingLease({
    database: db,
    logPrefix: '[TG]',
    onAcquired: startBot,
    onLost: stopBot
  });
  pollingLease.start();
  setTimeout(cleanupOldTopics, 15000);
  setInterval(cleanupOldTopics, 60 * 60 * 1000);
  setInterval(retryMissingTopics, 60 * 1000);
  setTimeout(retryMissingTopics, 10 * 1000);
  deliveryTimer = setInterval(processDeliveryQueue, 15 * 1000);
  setTimeout(processDeliveryQueue, 5000);
  return bot;
}

async function startBot() {
  if (bot) return bot;
  console.log('[TG] Starting...');
  let instance = null;
  try {
    instance = new TelegramBot(TOKEN, {
      polling: {
        interval: 2000,
        autoStart: false,
        params: { timeout: 30, allowed_updates: ['message', 'callback_query', 'message_reaction', 'message_reaction_count'] }
      }
    });
    bot = instance;
    instance.on('polling_error', err => {
      if (instance !== bot) return;
      if (connected) { connected = false; console.error('[TG] Lost:', err.message); }
      if (isPollingConflict(err)) {
        reportPollingConflict(err);
        return;
      }
      const notify = recordPollingError(err);
      console.error(`[TG] Polling (${pollingStats.consecutiveErrors}/${POLLING_ALERT_AFTER_ERRORS}):`, tgError(err));
      if (notify) {
        operationalAlert('telegram-polling', 'Потеряно соединение с Telegram', tgError(err)).catch(() => {});
      }
    });
    instance.on('error', err => { if (instance === bot) console.error('[TG] Error:', err.message); });
    instance.on('message', async msg => { resetPollingErrors(); if (!connected) { connected = true; console.log('[TG] Connected ✓'); } await handleMessage(msg); });
    instance.on('callback_query', async query => { resetPollingErrors(); if (!connected) { connected = true; console.log('[TG] Connected ✓'); } await handleCallbackQuery(query); });
    instance.on('message_reaction', async update => { resetPollingErrors(); if (!connected) { connected = true; console.log('[TG] Connected ✓'); } await handleMessageReaction(update); });
    instance.on('message_reaction_count', async update => { resetPollingErrors(); if (!connected) { connected = true; console.log('[TG] Connected ✓'); } await handleMessageReactionCount(update); });
    await instance.startPolling();
    connected = true;
    resetPollingErrors();
    await configureAdminWebApp(instance);
    return instance;
  } catch (e) {
    if (bot === instance) bot = null;
    await instance?.stopPolling?.({ cancel: true, reason: 'Polling startup failed' }).catch(() => {});
    console.error('[TG] Failed to start:', e.message);
    throw e;
  }
}

async function stopBot(reason = 'lease-lost') {
  const previous = bot;
  bot = null;
  connected = false;
  if (previous) await previous.stopPolling({ cancel: true, reason }).catch(() => {});
}

async function configureAdminWebApp(instance = bot) {
  if (!instance || !WEBAPP_URL || instance !== bot) return;
  await instance.setMyCommands([
    { command: 'admin', description: 'Открыть админку' },
    { command: 'close', description: 'Закрыть тикет в текущей теме' }
  ]).catch(() => {});
  await instance.setChatMenuButton({
    menu_button: { type: 'web_app', text: 'Админка', web_app: { url: adminWebAppUrlWithCacheBust() } }
  }).catch(() => {});
  console.log(`[TG] Admin Mini App: ${WEBAPP_URL}`);
}

function status() {
  const s = cfg();
  let openTicketsWithoutTopic = 0;
  try {
    openTicketsWithoutTopic = db.getOpenTicketsWithoutTelegramTopic.all(1000).length;
  } catch {}
  return {
    configured: !!TOKEN && !!GROUP_ID,
    enabled: !!s.telegramEnabled,
    createTopics: !!s.telegramCreateTopics,
    botStarted: !!bot,
    connected,
    polling: {
      ...(pollingLease?.status() || { owner: false, pausedUntil: null }),
      ...pollingStats
    },
    miniAppConfigured: !!WEBAPP_URL,
    miniAppUrl: WEBAPP_URL || null,
    miniAppAllowedAdmins: TELEGRAM_ADMIN_IDS.size,
    pendingTopicCreates: creatingTopics.size,
    openTicketsWithoutTopic,
    delivery: { ...deliveryStats, inFlight: forwardingMessages.size }
  };
}

async function shutdown() {
  clearTimeout(cleanupTimer);
  clearInterval(deliveryTimer);
  cleanupTimer = null;
  deliveryTimer = null;
  await pollingLease?.stop();
  pollingLease = null;
  await stopBot('shutdown');
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
    }
  } catch (e) { console.error('[TG] handleCallbackQuery:', e.message); }
}

function reactionLabel(reaction) {
  if (!reaction) return '';
  if (reaction.type === 'emoji') return reaction.emoji || '';
  if (reaction.type === 'custom_emoji') return '💠';
  if (reaction.type === 'paid') return '⭐';
  return '';
}

async function handleMessageReaction(update) {
  try {
    if (!tgEnabled()) return;
    if (String(update.chat?.id) !== String(GROUP_ID)) return;
    const msg = db.getMessageByTelegramId.get(update.message_id);
    if (!msg) return;
    const reactions = (update.new_reaction || []).map(reactionLabel).filter(Boolean);
    const payload = JSON.stringify(reactions);
    db.updateMessageReactions.run(payload, msg.id);
    io?.to(`ticket:${msg.ticket_id}`).emit('message_reactions', { messageId: msg.id, reactions });
    io?.to('admin').emit('admin_message_reactions', { ticketId: msg.ticket_id, messageId: msg.id, reactions });
  } catch (e) { console.error('[TG] handleMessageReaction:', e.message); }
}

async function handleMessageReactionCount(update) {
  try {
    if (!tgEnabled()) return;
    if (String(update.chat?.id) !== String(GROUP_ID)) return;
    const msg = db.getMessageByTelegramId.get(update.message_id);
    if (!msg) return;
    const reactions = (update.reactions || [])
      .map(item => {
        const label = reactionLabel(item.type);
        if (!label) return '';
        return item.total_count > 1 ? `${label} ${item.total_count}` : label;
      })
      .filter(Boolean);
    const payload = JSON.stringify(reactions);
    db.updateMessageReactions.run(payload, msg.id);
    io?.to(`ticket:${msg.ticket_id}`).emit('message_reactions', { messageId: msg.id, reactions });
    io?.to('admin').emit('admin_message_reactions', { ticketId: msg.ticket_id, messageId: msg.id, reactions });
  } catch (e) { console.error('[TG] handleMessageReactionCount:', e.message); }
}

function parseCmd(text) {
  if (!text) return null;
  const match = text.trim().toLowerCase().match(/^(\/\w+)(?:@\w+)?/);
  return match ? match[1] : null;
}

async function handleMessage(msg) {
  const incomingKey = `${msg.chat?.id}:${msg.message_id}`;
  let claimedIncoming = false;
  try {
    if (!tgEnabled()) return;
    const s = cfg();
    if (String(msg.chat.id) !== String(GROUP_ID)) return;
    const topicId = msg.message_thread_id;
    const rootCmd = parseCmd(msg.text || msg.caption || null);

    if (isDisposableTelegramServiceMessage(msg)) {
      if (s.telegramDeleteRenameNotices) {
        await deleteTelegramServiceMessage(msg);
      }
      return;
    }

    if (rootCmd === '/admin') {
      await announceAdminWebApp(topicId || null, msg.from);
      return;
    }

    if (msg.from && msg.from.is_bot) return;
    let ticket = topicId ? db.getTicketByTopicIdAny.get(topicId) : null;
    let replyMsg = null;
    if (!ticket && msg.reply_to_message) {
      replyMsg = db.getMessageByTelegramId.get(msg.reply_to_message.message_id);
      if (replyMsg) ticket = db.getTicketById.get(replyMsg.ticket_id);
    }
    if (!ticket) {
      if (!topicId && !rootCmd && (msg.text || msg.caption)) {
        await safeSend(GROUP_ID, 'Ответьте reply на сообщение тикета, чтобы бот понял, какому пользователю писать.');
      }
      return;
    }
    const rawText = msg.text || msg.caption || null;
    const cmd = parseCmd(rawText);
    const sendOpts = topicId ? { message_thread_id: topicId } : {};

    if (cmd === '/close') {
      if (ticket.status === 'closed') return safeSend(GROUP_ID, 'Тикет уже закрыт.', sendOpts);
      await closeTicketFromTelegram(ticket, topicId);
      return;
    }

    if (ticket.status === 'closed') {
      await safeSend(GROUP_ID, 'Тикет закрыт. Создайте новое обращение, если снова понадобится помощь.', sendOpts);
      return;
    }

    if (!s.telegramForwardOperatorMessages) return;

    // Telegram may redeliver an update after a polling reconnect. Processing the
    // same update twice would show two identical operator messages to the client.
    if (incomingMessages.has(incomingKey) || db.getMessageByTelegramId.get(msg.message_id)) {
      deliveryStats.incomingDuplicates++;
      return;
    }
    incomingMessages.add(incomingKey);
    claimedIncoming = true;

    let type = 'text', fileUrl = null, fileName = null, fileMime = null;
    if (msg.photo || msg.video || msg.document || msg.voice || msg.audio || msg.animation || msg.video_note) {
      const f = await downloadFile(msg);
      if (f) { fileUrl = f.url; fileName = f.name; fileMime = f.mime; type = f.type; }
      else {
        deliveryStats.mediaFailures++;
        await operationalAlert(`tg-media-${ticket.id}`, `Не удалось получить файл из Telegram (тикет ${shortId(ticket)})`, `Telegram message_id=${msg.message_id}`);
        await safeSend(GROUP_ID, '⚠️ Файл не доставлен клиенту. Попробуйте отправить его ещё раз или как документ.', sendOpts);
      }
    }
    if (!rawText && !fileUrl) return;

    let replyToId = null, replyToContent = null, replyToSenderName = null, replyToType = null, replyToFileName = null;
    if (msg.reply_to_message) {
      replyMsg = replyMsg || db.getMessageByTelegramId.get(msg.reply_to_message.message_id);
      if (replyMsg && replyMsg.ticket_id === ticket.id) {
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

    const message = {
      id, ticket_id: ticket.id, sender: 'support', sender_name: senderName,
      content: rawText, message_type: type, file_url: fileUrl, file_name: fileName, file_mime: fileMime,
      created_at: new Date().toISOString(), reply_to_id: replyToId || null,
      reply_to_content: replyToContent || null, reply_to_sender_name: replyToSenderName || null,
      reply_to_type: replyToType || null, reply_to_file_name: replyToFileName || null
    };
    io?.to(`ticket:${ticket.id}`).emit('message', message);
    io?.to('admin').emit('admin_new_message', { ticketId: ticket.id, message });
    if (topicId) await setTopicStatus(topicId, ticket, s.telegramOpenEmoji);
    push.send(ticket.id, rawText || 'Новое сообщение').catch(() => {});
  } catch (e) { console.error('[TG] handleMessage:', e.message); }
  finally { if (claimedIncoming) incomingMessages.delete(incomingKey); }
}

async function closeTicketFromTelegram(ticket, topicId) {
  const s = cfg();
  db.closeTicket.run(ticket.id);
  io?.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'support' });
  io?.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  if (topicId) await setTopicStatus(topicId, ticket, s.telegramClosedEmoji);
  await safeSend(GROUP_ID, s.telegramClosedBySupportText, topicId ? { message_thread_id: topicId } : {});
  if (topicId && s.telegramCloseTopicOnClose) await bot.closeForumTopic(GROUP_ID, topicId).catch(() => {});
  if (s.telegramCleanupClosedTopics && s.telegramCleanupClosedHours === 0) scheduleCleanupOldTopics();
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
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) try {
    let fileId, fileName, fileMime, type;
    if (msg.photo) {
      const p = msg.photo[msg.photo.length - 1];
      fileId = p.file_id; fileName = `photo_${Date.now()}.jpg`; fileMime = 'image/jpeg'; type = 'image';
    } else if (msg.video) {
      fileId = msg.video.file_id; fileName = msg.video.file_name || `video_${Date.now()}.mp4`; fileMime = msg.video.mime_type || 'video/mp4'; type = 'video';
    } else if (msg.document) {
      fileId = msg.document.file_id; fileName = msg.document.file_name || `file_${Date.now()}`; fileMime = msg.document.mime_type || 'application/octet-stream';
      const ext = path.extname(fileName).toLowerCase();
      type = fileMime.startsWith('image/') && DISPLAY_IMAGE_EXTS.has(ext) ? 'image' : fileMime.startsWith('video/') ? 'video' : fileMime.startsWith('audio/') ? 'audio' : 'file';
    } else if (msg.voice) {
      fileId = msg.voice.file_id; fileName = `voice_${Date.now()}.ogg`; fileMime = msg.voice.mime_type || 'audio/ogg'; type = 'audio';
    } else if (msg.audio) {
      fileId = msg.audio.file_id; fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`; fileMime = msg.audio.mime_type || 'audio/mpeg'; type = 'audio';
    } else if (msg.animation) {
      fileId = msg.animation.file_id; fileName = msg.animation.file_name || `animation_${Date.now()}.mp4`; fileMime = msg.animation.mime_type || 'video/mp4'; type = 'video';
    } else if (msg.video_note) {
      fileId = msg.video_note.file_id; fileName = `video_note_${Date.now()}.mp4`; fileMime = 'video/mp4'; type = 'video';
    }
    if (!fileId) return null;
    const link = await bot.getFileLink(fileId);
    const controller = new AbortController();
    // Видео до 50 МБ на медленном VPS не всегда успевает за прежние 30 секунд.
    const fetchTimeout = setTimeout(() => controller.abort(), 120000);
    let resp;
    try { resp = await fetch(link, { signal: controller.signal }); }
    finally { clearTimeout(fetchTimeout); }
    if (!resp.ok) throw new Error('fetch failed');
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > cfg().uploadMaxMb * 1024 * 1024) throw new Error('File too large');
    const dir = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cleanName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160) || 'file';
    const safe = `tg_${uuidv4()}_${cleanName}`;
    await fsp.writeFile(path.join(dir, safe), buf, { flag: 'wx' });
    return { url: `/uploads/${safe}`, name: String(fileName).slice(0, 255), mime: fileMime, type };
  } catch (e) {
    lastError = e;
    console.error(`[TG] downloadFile attempt ${attempt}:`, e.message);
    if (attempt < 3) await wait(attempt * 1000);
  }
  deliveryStats.lastError = tgError(lastError);
  return null;
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

  const existing = db.getTicketById.get(ticketId);
  if (existing?.telegram_topic_id) return existing.telegram_topic_id;
  if (creatingTopics.has(ticketId)) return creatingTopics.get(ticketId);

  const promise = (async () => {
    try {
      const ticket = existing || { id: ticketId, user_name: userName, created_at: new Date().toISOString() };
      const topic = await bot.createForumTopic(GROUP_ID, topicName(ticket, s.telegramNewEmoji));
      const topicId = topic.message_thread_id;
      db.setTopicId.run(topicId, ticketId);
      topicStatus.set(topicId, topicName(ticket, s.telegramNewEmoji));
      const text = formatTemplate(s.telegramNewTicketText, { ...values(ticket), name: mdEscape(userName), shortId: ticketId.slice(0, 8) });
      const infoMsg = await safeSend(GROUP_ID, text, { message_thread_id: topicId, parse_mode: 'Markdown', reply_markup: kbClose(topicId) });
      if (infoMsg && s.telegramPinNewTicketMessage) await bot.pinChatMessage(GROUP_ID, infoMsg.message_id, { message_thread_id: topicId }).catch(() => {});
      console.log(`[TG] Created topic ${topicId} for ticket ${ticketId.slice(0, 8)}`);
      return topicId;
    } catch (e) {
      console.error(`[TG] createTopic ${ticketId.slice(0, 8)}:`, tgError(e));
      return null;
    } finally {
      creatingTopics.delete(ticketId);
    }
  })();

  creatingTopics.set(ticketId, promise);
  return promise;
}

async function forwardMessage(ticket, message, opts = {}) {
  const s = cfg();
  if (!tgEnabled()) return;
  if (message.sender === 'user' && !s.telegramForwardUserMessages) return;
  if (message.sender === 'support' && !s.telegramForwardAdminMessages) return;

  if (!ticket?.telegram_topic_id && !opts.skipEnsureTopic && s.telegramCreateTopics) {
    const topicId = await createTopic(ticket.id, ticket.user_name);
    if (topicId) ticket = db.getTicketById.get(ticket.id);
  }
  if (!ticket?.telegram_topic_id && s.telegramCreateTopics) return;

  const tid = ticket.telegram_topic_id;
  const targetOpts = tid ? { message_thread_id: tid } : {};
  if (message.telegram_message_id || forwardingMessages.has(message.id)) return message.telegram_message_id || null;
  forwardingMessages.add(message.id);
  try {
    let sent;
    const fp = publicUploadPath(message.file_url);
    if (!tid && message.sender === 'user') {
      const text = singleChatMessage(ticket, message);
      if (message.message_type === 'text') sent = await bot.sendMessage(GROUP_ID, text.slice(0, 4090), { parse_mode: 'HTML' });
      else if (message.message_type === 'image' && fp) sent = await sendWithDocumentFallback(
        () => bot.sendPhoto(GROUP_ID, fp, { caption: text.slice(0, 1000), parse_mode: 'HTML' }),
        fp,
        { caption: text.slice(0, 1000), parse_mode: 'HTML' }
      );
      else if (message.message_type === 'video' && fp) sent = await sendWithDocumentFallback(
        () => bot.sendVideo(GROUP_ID, fp, { caption: text.slice(0, 1000), parse_mode: 'HTML' }),
        fp,
        { caption: text.slice(0, 1000), parse_mode: 'HTML' }
      );
      else if (message.message_type === 'audio' && fp) sent = await bot.sendVoice(GROUP_ID, fp, { caption: text.slice(0, 1000), parse_mode: 'HTML' });
      else if (fp) sent = await bot.sendDocument(GROUP_ID, fp, { caption: text.slice(0, 1000), parse_mode: 'HTML' });
    } else if (!tid && message.sender === 'support') {
      const text = singleChatMessage(ticket, message);
      sent = await bot.sendMessage(GROUP_ID, text.slice(0, 4090), { parse_mode: 'HTML' });
    } else if (message.message_type === 'text') sent = await bot.sendMessage(GROUP_ID, String(message.content || '').slice(0, 4000), targetOpts);
    else if (message.message_type === 'image' && fp) sent = await sendWithDocumentFallback(
      () => bot.sendPhoto(GROUP_ID, fp, { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined }),
      fp,
      { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined }
    );
    else if (message.message_type === 'video' && fp) sent = await sendWithDocumentFallback(
      () => bot.sendVideo(GROUP_ID, fp, { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined }),
      fp,
      { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined }
    );
    else if (message.message_type === 'audio' && fp) sent = await sendWithDocumentFallback(
      () => bot.sendAudio(GROUP_ID, fp, { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined }),
      fp,
      { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined }
    );
    else if (fp) sent = await bot.sendDocument(GROUP_ID, fp, { ...targetOpts, caption: message.content ? String(message.content).slice(0, 1000) : undefined });
    if (!sent) throw new Error('Telegram did not confirm delivery');
    db.updateTelegramMessageId.run(sent.message_id, message.id);
    deliveryStats.delivered++;
    deliveryStats.lastSuccessAt = new Date().toISOString();
    if (tid) await setTopicStatus(tid, ticket, message.sender === 'user' ? s.telegramWaitEmoji : s.telegramOpenEmoji);
    return sent.message_id;
  } catch (e) {
    if (tid && isThreadNotFound(e)) {
      db.markTopicDeleted.run(ticket.id);
      await operationalAlert(`tg-topic-${ticket.id}`, `Telegram-тема тикета ${shortId(ticket)} недоступна`, tgError(e));
    }
    const attempts = Number(message.telegram_attempts || 0) + 1;
    const delaySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)));
    db.markTelegramAttempt.run(tgError(e).slice(0, 1000), `+${delaySeconds} seconds`, message.id);
    deliveryStats.failed++;
    deliveryStats.lastError = tgError(e);
    console.error('[TG] forwardMessage:', tgError(e));
    if (attempts >= 3) await operationalAlert(`tg-delivery-${message.id}`, `Сообщение не доставлено в Telegram после ${attempts} попыток`, `Тикет ${shortId(ticket)}: ${tgError(e)}`);
    throw e;
  } finally {
    forwardingMessages.delete(message.id);
  }
}

async function processDeliveryQueue() {
  if (deliveryRunning || !tgEnabled()) return;
  deliveryRunning = true;
  try {
    const messages = db.getPendingTelegramMessages.all(20);
    for (const message of messages) {
      const ticket = db.getTicketById.get(message.ticket_id);
      if (!ticket) continue;
      if (Number(message.telegram_attempts || 0) > 0) deliveryStats.retried++;
      await forwardMessage(ticket, message).catch(() => {});
      await wait(250);
    }
  } catch (e) {
    deliveryStats.lastError = tgError(e);
    console.error('[TG] delivery queue:', tgError(e));
  } finally { deliveryRunning = false; }
}

async function notifyTicketClosed(ticket) {
  const s = cfg();
  if (!tgEnabled()) return;
  if (!ticket.telegram_topic_id && !s.telegramCreateTopics) {
    await safeSend(GROUP_ID, singleChatStatus(ticket, s.telegramClosedByUserText), { parse_mode: 'HTML' });
    return;
  }
  if (!ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    await setTopicStatus(tid, ticket, s.telegramClosedEmoji);
    await safeSend(GROUP_ID, s.telegramClosedByUserText, { message_thread_id: tid });
    if (s.telegramCloseTopicOnClose) await bot.closeForumTopic(GROUP_ID, tid).catch(() => {});
    if (s.telegramCleanupClosedTopics && s.telegramCleanupClosedHours === 0) scheduleCleanupOldTopics();
  } catch (e) { console.error('[TG] notifyTicketClosed:', e.message); }
}

async function autoCloseTicket(ticket, extra = {}) {
  const s = cfg();
  if (!tgEnabled()) return;
  if (!ticket.telegram_topic_id && !s.telegramCreateTopics) {
    await safeSend(GROUP_ID, singleChatStatus(ticket, formatTemplate(s.telegramAutoCloseText, { ...values(ticket), ...extra })), { parse_mode: 'HTML' });
    return;
  }
  if (!ticket.telegram_topic_id) return;
  const tid = ticket.telegram_topic_id;
  try {
    topicStatus.delete(tid);
    await setTopicStatus(tid, ticket, s.telegramClosedEmoji);
    await safeSend(GROUP_ID, formatTemplate(s.telegramAutoCloseText, { ...values(ticket), ...extra }), { message_thread_id: tid });
    if (s.telegramCloseTopicOnClose) await bot.closeForumTopic(GROUP_ID, tid).catch(() => {});
    if (s.telegramCleanupClosedTopics && s.telegramCleanupClosedHours === 0) scheduleCleanupOldTopics();
  } catch (e) { console.error('[TG] autoCloseTicket:', e.message); }
}

async function warnInactivity(ticket, extra = {}) {
  const s = cfg();
  if (!tgEnabled()) return;
  if (!ticket.telegram_topic_id && !s.telegramCreateTopics) {
    await safeSend(GROUP_ID, singleChatStatus(ticket, formatTemplate(s.telegramWarnInactivityText, { ...values(ticket), ...extra })), { parse_mode: 'HTML' });
    return;
  }
  if (!ticket.telegram_topic_id) return;
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

async function replayUnsentMessages(ticket, limit = 30) {
  if (!tgEnabled() || !ticket?.telegram_topic_id) return;
  const messages = db.getUnsentMessagesForTelegram.all(ticket.id, limit);
  if (!messages.length) return;

  console.log(`[TG] Replaying ${messages.length} unsent messages for ${shortId(ticket)}`);
  for (const message of messages) {
    await forwardMessage(ticket, message, { skipEnsureTopic: true });
    await wait(350);
  }
  if (messages.length === limit) {
    await safeSend(
      GROUP_ID,
      `⚠️ У тикета ${shortId(ticket)} есть еще старые сообщения. Откройте диалог в админке для полной истории.`,
      { message_thread_id: ticket.telegram_topic_id }
    );
  }
}

async function retryMissingTopics() {
  if (!tgEnabled() || !cfg().telegramCreateTopics) return;
  const tickets = db.getOpenTicketsWithoutTelegramTopic.all(10);
  if (!tickets.length) return;

  console.warn(`[TG] Found ${tickets.length} open tickets without Telegram topic, retrying...`);
  for (const ticket of tickets) {
    const topicId = await createTopic(ticket.id, ticket.user_name);
    if (topicId) {
      const fresh = db.getTicketById.get(ticket.id);
      io?.to('admin').emit('admin_ticket_updated', fresh);
      io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
      await replayUnsentMessages(fresh);
    }
    await wait(1200);
  }
}

async function cleanupOldTopics() {
  const s = cfg();
  if (!tgEnabled() || !s.telegramCleanupClosedTopics) return;
  try {
    const cutoff = new Date(Date.now() - s.telegramCleanupClosedHours * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const rows = db.db.prepare(`SELECT * FROM tickets WHERE status='closed' AND closed_at < ? AND telegram_topic_id IS NOT NULL`).all(cutoff);
    for (const t of rows) {
      try {
        await bot.deleteForumTopic(GROUP_ID, t.telegram_topic_id);
        db.markTopicDeleted.run(t.id);
        topicStatus.delete(t.telegram_topic_id);
        console.log(`[TG] Cleaned topic ${shortId(t)}`);
      } catch (e) {
        if (isThreadNotFound(e)) {
          db.markTopicDeleted.run(t.id);
          topicStatus.delete(t.telegram_topic_id);
          console.log(`[TG] Topic already gone ${shortId(t)}`);
        } else {
          console.error(`[TG] cleanup topic ${shortId(t)}:`, e.message);
        }
      }
      await new Promise(r => setTimeout(r, 600));
    }
  } catch (e) { console.error('[TG] cleanup:', e.message); }
}

module.exports = {
  init,
  createTopic,
  forwardMessage,
  notifyTicketClosed,
  autoCloseTicket,
  sendTyping,
  warnInactivity,
  checkTopicAlive,
  status,
  notifyOperationalIssue: operationalAlert,
  shutdown
};
