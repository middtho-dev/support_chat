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
const ADMIN_IDS = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const DISPLAY_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const TICKET_LIST_PAGE_SIZE = 8;
const POLLING_INTERVAL_MS = Math.max(
  100,
  Math.min(2000, Number(process.env.TELEGRAM_POLL_INTERVAL_MS) || 300)
);
const TOPIC_CREATE_ATTEMPTS = Math.max(
  1,
  Math.min(8, Number(process.env.TELEGRAM_TOPIC_CREATE_ATTEMPTS) || 4)
);
const TOPIC_CREATE_RETRY_MS = Math.max(
  100,
  Math.min(10000, Number(process.env.TELEGRAM_TOPIC_CREATE_RETRY_MS) || 1000)
);
const IMAGE_EXTS = new Set([...DISPLAY_IMAGE_EXTS, '.heic', '.heif', '.bmp', '.tif', '.tiff', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.wav', '.flac', '.opus']);
const DOCUMENT_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.7z', '.rar', '.txt', '.csv']);
const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'text/plain',
  'text/csv',
  'image/heic',
  'image/heif',
  'image/avif',
  'image/tiff',
  'image/bmp'
]);
const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus'
};

let bot = null;
let io = null;
let lifecycle = {};
let cleanupTimer = null;
let deliveryTimer = null;
let reminderTimer = null;
let deliveryWakeTimer = null;
let deliveryWakeAt = 0;
let deliveryRunning = false;
let reminderRunning = false;
let connected = false;
let threadedModeEnabled = false;
let richMessagesAvailable = true;
let botUsername = '';
let pollingLease = null;

const creatingThreads = new Map();
const assigningTickets = new Map();
const forwardingMessages = new Set();
const customerDeliveryMessages = new Set();
const customerControlMessages = new Map();
const closingCustomerTickets = new Set();
const incomingMessages = new Set();
const customerMessageRates = new Map();
const alertTimes = new Map();
const topicStatus = new Map();
const focusMarkers = new Map();
const deliveryStats = {
  delivered: 0,
  failed: 0,
  retried: 0,
  incomingDuplicates: 0,
  mediaFailures: 0,
  unassigned: 0,
  customerDelivered: 0,
  customerFailed: 0,
  lastError: null,
  lastSuccessAt: null
};
const pollingStats = {
  conflicts: 0,
  lastConflictAt: null,
  lastConflict: null,
  consecutiveErrors: 0,
  lastError: null
};
const POLLING_ALERT_AFTER_ERRORS = 3;
const reminderStats = {
  sent: 0,
  failed: 0,
  lastSentAt: null,
  lastError: null
};
const latencySamples = {
  topicCreateMs: [],
  deliveryMs: [],
  closeMs: [],
  reopenMs: []
};

function cfg() {
  return loadSettings();
}

function tgEnabled() {
  return cfg().telegramEnabled && !!bot && !!TOKEN && !!pollingLease?.isOwner();
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function backgroundTimer(timer) {
  timer.unref?.();
  return timer;
}

function observeLatency(metric, startedAt) {
  const samples = latencySamples[metric];
  if (!samples) return;
  samples.push(Math.max(0, Date.now() - startedAt));
  if (samples.length > 100) samples.splice(0, samples.length - 100);
}

function latencySummary() {
  const result = {};
  for (const [metric, samples] of Object.entries(latencySamples)) {
    const sorted = [...samples].sort((a, b) => a - b);
    result[metric] = {
      count: sorted.length,
      last: samples.at(-1) ?? null,
      p50: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.5)] : null,
      p95: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : null
    };
  }
  return result;
}

function scheduleDeliveryQueue(delayMs = 0) {
  const safeDelay = Math.max(0, Number(delayMs) || 0);
  const runAt = Date.now() + safeDelay;
  if (deliveryWakeTimer && deliveryWakeAt <= runAt) return;
  if (deliveryWakeTimer) clearTimeout(deliveryWakeTimer);
  deliveryWakeAt = runAt;
  deliveryWakeTimer = setTimeout(() => {
    deliveryWakeTimer = null;
    deliveryWakeAt = 0;
    if (deliveryRunning) {
      scheduleDeliveryQueue(250);
      return;
    }
    processDeliveryQueue().catch(() => {});
  }, safeDelay);
}

function shortId(ticket) {
  return String(ticket?.id || '').slice(0, 8);
}

function tgError(error) {
  return String(error?.response?.body?.description || error?.message || error || 'unknown error');
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
  console.error(
    '[TG private] Another getUpdates consumer is active; polling will retry automatically:',
    details
  );

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

function normalizeIncomingDocument(fileName, declaredMime) {
  const extension = path.extname(fileName || '').toLowerCase();
  const mime = !declaredMime || declaredMime === 'application/octet-stream'
    ? MIME_BY_EXTENSION[extension] || declaredMime || 'application/octet-stream'
    : String(declaredMime).toLowerCase();
  const allowed =
    (mime.startsWith('image/') && IMAGE_EXTS.has(extension)) ||
    (mime.startsWith('video/') && VIDEO_EXTS.has(extension)) ||
    (mime.startsWith('audio/') && AUDIO_EXTS.has(extension)) ||
    (DOCUMENT_MIMES.has(mime) && DOCUMENT_EXTS.has(extension));
  if (!allowed) throw new Error(`Unsupported Telegram file type: ${extension || 'no extension'} (${mime})`);
  const type = mime.startsWith('image/') && DISPLAY_IMAGE_EXTS.has(extension)
    ? 'image'
    : mime.startsWith('video/')
      ? 'video'
      : mime.startsWith('audio/')
        ? 'audio'
        : 'file';
  return { mime, type };
}

function isThreadNotFound(error) {
  const message = tgError(error).toLowerCase();
  return message.includes('thread not found') ||
    message.includes('topic_deleted') ||
    message.includes('topic_closed');
}

function markdownEscape(value) {
  return String(value ?? '').replace(/([\\`*_[\]{}()#+\-.!>|])/g, '\\$1');
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[character]);
}

function topicKey(chatId, threadId) {
  return `${chatId}:${threadId}`;
}

function operatorName(from) {
  const fullName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
  return fullName || from?.username || `Оператор ${from?.id || ''}`.trim();
}

function customerName(from) {
  const fullName = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
  return fullName || from?.username || `Telegram ${from?.id || ''}`.trim();
}

function customerProfile(ticket) {
  const telegramId = String(ticket?.telegram_customer_id || '');
  const username = String(ticket?.telegram_customer_username || '').replace(/^@/, '');
  return {
    telegramId,
    username,
    profileUrl: username && /^[a-zA-Z0-9_]{5,32}$/.test(username)
      ? `https://t.me/${username}`
      : telegramId
        ? `tg://user?id=${encodeURIComponent(telegramId)}`
        : ''
  };
}

function isAuthorized(userId) {
  return ADMIN_IDS.has(String(userId || ''));
}

function adminWebAppUrl(ticketId = '') {
  const explicit = process.env.TELEGRAM_WEBAPP_URL || process.env.ADMIN_WEBAPP_URL;
  const base = explicit || (() => {
    const publicUrl = process.env.PUBLIC_URL || process.env.APP_URL || process.env.BASE_URL;
    return publicUrl ? `${String(publicUrl).replace(/\/+$/, '')}/miniapp` : '';
  })();
  if (!base) return '';
  try {
    const url = new URL(base);
    url.searchParams.set('v', Date.now().toString(36));
    if (ticketId) url.searchParams.set('ticket', ticketId);
    return url.toString();
  } catch {
    return '';
  }
}

function tgButton(text, callbackData, style, customEmojiId) {
  const button = { text, callback_data: callbackData };
  if (style) button.style = style;
  if (customEmojiId) button.icon_custom_emoji_id = customEmojiId;
  return button;
}

function ticketKeyboard(ticket, state = 'open') {
  const settings = cfg();
  const rows = [];
  if (state === 'unassigned') {
    rows.push([tgButton('🙋 Взять тикет', `take:${ticket.id}`, 'primary')]);
  } else if (state === 'closed') {
    rows.push([tgButton(
      settings.telegramReopenButtonText,
      `reopen:${ticket.id}`,
      settings.telegramReopenButtonStyle,
      settings.telegramReopenButtonEmojiId
    )]);
  } else {
    rows.push([tgButton(
      settings.telegramCloseButtonText,
      `close:${ticket.id}`,
      settings.telegramCloseButtonStyle,
      settings.telegramCloseButtonEmojiId
    )]);
  }
  const webAppUrl = adminWebAppUrl(ticket.id);
  if (webAppUrl) rows.push([{ text: '💬 Открыть чат', web_app: { url: webAppUrl } }]);
  const customer = customerProfile(ticket);
  if (ticket.source === 'telegram' && customer.telegramId) {
    const profileButtons = [];
    if (customer.profileUrl) {
      profileButtons.push({ text: '👤 Профиль клиента', url: customer.profileUrl });
    }
    profileButtons.push({
      text: '📋 Копировать ID',
      copy_text: { text: customer.telegramId }
    });
    rows.push(profileButtons);
    if (state === 'open') {
      rows.push([{
        text: settings.telegramCustomerSendCloseButtonText,
        callback_data: `customercontrol:${ticket.id}`
      }]);
    }
  }
  return { inline_keyboard: rows };
}

function operatorCanControlTicket(ticket, operatorId, query) {
  if (String(ticket.assigned_operator_id || '') === String(operatorId)) return true;

  const chatId = String(query?.message?.chat?.id || '');
  const threadId = Number(query?.message?.message_thread_id || 0);
  if (!chatId || !threadId) return false;

  const thread = db.getTelegramThreadByDestination.get(chatId, threadId);
  return Boolean(
    thread
    && thread.ticket_id === ticket.id
    && String(thread.operator_id || '') === String(operatorId)
  );
}

function dashboardKeyboard(counts = {}) {
  const rows = [[
    { text: `🔔 Новые · ${Number(counts.waiting || 0)}`, callback_data: 'list:waiting:0' },
    { text: `🔵 Мои · ${Number(counts.mine || 0)}`, callback_data: 'list:mine:0' }
  ], [
    { text: `✅ Закрытые · ${Number(counts.closed || 0)}`, callback_data: 'list:closed:0' },
    { text: '🔄 Обновить', callback_data: 'dashboard:refresh' }
  ]];
  const webAppUrl = adminWebAppUrl();
  if (webAppUrl) rows.push([{ text: '🖥 Админка', web_app: { url: webAppUrl } }]);
  return { inline_keyboard: rows };
}

function dashboardCounts(operator) {
  return db.db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'open' AND assigned_operator_id IS NULL THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'open' AND assigned_operator_id = ? THEN 1 ELSE 0 END) AS mine,
      SUM(CASE WHEN status = 'closed' AND assigned_operator_id = ? THEN 1 ELSE 0 END) AS closed
    FROM tickets
  `).get(operator.telegram_user_id, operator.telegram_user_id);
}

function dashboardModel(operator) {
  const counts = dashboardCounts(operator);
  const markdown = [
    '## 🛟 Панель оператора',
    `**${markdownEscape(operator.display_name)}**`,
    '',
    `- 🔔 Новые без оператора: **${Number(counts.waiting || 0)}**`,
    `- 🔵 Мои открытые: **${Number(counts.mine || 0)}**`,
    `- ✅ Мои закрытые: **${Number(counts.closed || 0)}**`,
    '',
    threadedModeEnabled
      ? 'Выберите раздел кнопками ниже.'
      : '⚠️ Включите **Threaded Mode** у бота через @BotFather.'
  ].join('\n');
  const fallback = [
    '🛟 Панель оператора',
    operator.display_name,
    '',
    `🔔 Новые без оператора: ${Number(counts.waiting || 0)}`,
    `🔵 Мои открытые: ${Number(counts.mine || 0)}`,
    `✅ Мои закрытые: ${Number(counts.closed || 0)}`,
    '',
    threadedModeEnabled
      ? 'Выберите раздел кнопками ниже.'
      : '⚠️ Включите Threaded Mode через @BotFather.'
  ].join('\n');
  return { markdown, fallback, replyMarkup: dashboardKeyboard(counts) };
}

function ticketListQuery(operator, view, page) {
  const offset = Math.max(0, page) * TICKET_LIST_PAGE_SIZE;
  if (view === 'waiting') {
    return {
      total: Number(db.countOpenUnassignedTickets.get()?.count || 0),
      tickets: db.getOpenUnassignedTicketsPage.all(TICKET_LIST_PAGE_SIZE, offset)
    };
  }
  if (view === 'closed') {
    return {
      total: Number(db.countClosedTicketsForOperator.get(operator.telegram_user_id)?.count || 0),
      tickets: db.getClosedTicketsForOperator.all(
        operator.telegram_user_id,
        TICKET_LIST_PAGE_SIZE,
        offset
      )
    };
  }
  return {
    total: Number(db.countOpenTicketsForOperator.get(operator.telegram_user_id)?.count || 0),
    tickets: db.getOpenTicketsForOperator.all(
      operator.telegram_user_id,
      TICKET_LIST_PAGE_SIZE,
      offset
    )
  };
}

function listTitle(view) {
  if (view === 'waiting') return '🔔 Новые тикеты';
  if (view === 'closed') return '✅ Закрытые тикеты';
  return '🔵 Мои открытые';
}

function listPreview(ticket) {
  const text = String(ticket.last_msg || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 110);
  if (ticket.last_msg_type === 'image') return '🖼 Изображение';
  if (ticket.last_msg_type === 'video') return '🎬 Видео';
  if (ticket.last_msg_type === 'audio') return '🎤 Аудио';
  if (ticket.last_file_name) return `📎 ${ticket.last_file_name}`;
  return 'Сообщений пока нет';
}

function listTicketButton(ticket, view, page) {
  const name = String(ticket.user_name || 'Клиент').replace(/\s+/g, ' ').slice(0, 34);
  if (view === 'waiting') {
    return tgButton(`🙋 Взять · ${name}`, `claim:${ticket.id}:${page}`, 'primary');
  }
  if (view === 'closed') {
    return tgButton(`🟢 Переоткрыть · ${name}`, `restore:${ticket.id}:${page}`, 'success');
  }
  return tgButton(`↗️ Поднять тему · ${name}`, `focus:${ticket.id}:${page}`, 'primary');
}

function ticketListKeyboard(tickets, view, page, total) {
  const rows = tickets.map(ticket => [listTicketButton(ticket, view, page)]);
  const nav = [];
  if (page > 0) nav.push({ text: '← Назад', callback_data: `list:${view}:${page - 1}` });
  if ((page + 1) * TICKET_LIST_PAGE_SIZE < total) {
    nav.push({ text: 'Дальше →', callback_data: `list:${view}:${page + 1}` });
  }
  if (nav.length) rows.push(nav);
  rows.push([{ text: '↩️ Панель оператора', callback_data: 'dashboard:show' }]);
  const webAppUrl = adminWebAppUrl();
  if (webAppUrl) rows.push([{ text: '🖥 Открыть админку', web_app: { url: webAppUrl } }]);
  return { inline_keyboard: rows };
}

function ticketListModel(operator, view, requestedPage = 0) {
  let page = Math.max(0, Number(requestedPage) || 0);
  let result = ticketListQuery(operator, view, page);
  const maxPage = Math.max(0, Math.ceil(result.total / TICKET_LIST_PAGE_SIZE) - 1);
  if (page > maxPage) {
    page = maxPage;
    result = ticketListQuery(operator, view, page);
  }
  const pageLabel = result.total > TICKET_LIST_PAGE_SIZE
    ? ` · страница ${page + 1}/${maxPage + 1}`
    : '';
  const lines = [`## ${listTitle(view)}`, `Всего: **${result.total}**${pageLabel}`, ''];
  const fallback = [listTitle(view), `Всего: ${result.total}${pageLabel}`, ''];
  if (!result.tickets.length) {
    lines.push('_Здесь пока пусто._');
    fallback.push('Здесь пока пусто.');
  } else {
    result.tickets.forEach((ticket, index) => {
      const number = page * TICKET_LIST_PAGE_SIZE + index + 1;
      const activity = ticket.last_activity
        ? new Date(ticket.last_activity).toLocaleString('ru-RU')
        : '';
      lines.push(
        `**${number}. ${markdownEscape(ticket.user_name || 'Клиент')}** · \`${markdownEscape(shortId(ticket))}\``,
        `> ${markdownEscape(listPreview(ticket))}`,
        activity ? `_${markdownEscape(activity)}_` : '',
        ''
      );
      fallback.push(
        `${number}. ${ticket.user_name || 'Клиент'} · ${shortId(ticket)}`,
        listPreview(ticket),
        activity,
        ''
      );
    });
    if (view === 'mine') {
      lines.push('_Кнопка «Поднять тему» переместит её наверх списка тем Telegram._');
      fallback.push('Кнопка «Поднять тему» переместит её наверх списка тем Telegram.');
    }
  }
  return {
    markdown: lines.filter((line, index, source) =>
      line !== '' || source[index - 1] !== ''
    ).join('\n'),
    fallback: fallback.join('\n').trim(),
    replyMarkup: ticketListKeyboard(result.tickets, view, page, result.total),
    page
  };
}

async function editPanel(message, model) {
  return editRichOrDisable(
    String(message.chat.id),
    message.message_id,
    model.markdown,
    model.replyMarkup,
    model.fallback
  );
}

function ticketRichMarkdown(ticket, state = 'unassigned', extra = {}) {
  const current = db.getTicketById.get(ticket.id) || ticket;
  const stateLabel = state === 'closed'
    ? '✅ Закрыт'
    : state === 'assigned'
      ? `🔵 В работе${extra.operatorName ? ` · ${markdownEscape(extra.operatorName)}` : ''}`
      : '🔔 Ждёт оператора';
  const created = current.created_at
    ? new Date(current.created_at).toLocaleString('ru-RU')
    : new Date().toLocaleString('ru-RU');
  const sourceLines = current.source === 'telegram'
    ? [
        `- Канал: Telegram`,
        `- Telegram ID: \`${markdownEscape(current.telegram_customer_id || '—')}\``,
        `- Username: ${current.telegram_customer_username ? `@${markdownEscape(current.telegram_customer_username)}` : '_не указан_'}`,
        `- Язык: ${markdownEscape(current.telegram_customer_language_code || '—')}`
      ]
    : ['- Канал: сайт'];

  return [
    `## ${stateLabel}`,
    `**${markdownEscape(current.user_name || 'Клиент')}** · \`${markdownEscape(shortId(current))}\``,
    state === 'assigned' && extra.operatorName
      ? `👤 Оператор: **${markdownEscape(extra.operatorName)}**`
      : '👤 Оператор: _не назначен_',
    `🕒 Создан: ${markdownEscape(created)}`,
    '',
    `<details><summary>Детали тикета</summary>`,
    '',
    `- Статус: ${markdownEscape(current.status || 'open')}`,
    `- ID: \`${markdownEscape(current.id)}\``,
    ...sourceLines,
    '',
    `</details>`
  ].join('\n');
}

function ticketFallbackText(ticket, state = 'unassigned', extra = {}) {
  const current = db.getTicketById.get(ticket.id) || ticket;
  const status = state === 'closed'
    ? '✅ Закрыт'
    : state === 'assigned'
      ? `🔵 В работе${extra.operatorName ? ` · ${extra.operatorName}` : ''}`
      : '🔔 Ждёт оператора';
  const source = current.source === 'telegram'
    ? `Telegram · ID ${current.telegram_customer_id || '—'}${current.telegram_customer_username ? ` · @${current.telegram_customer_username}` : ''}`
    : 'Сайт';
  return [
    status,
    `${current.user_name || 'Клиент'} · ${shortId(current)}`,
    state === 'assigned' && extra.operatorName
      ? `Оператор: ${extra.operatorName}`
      : 'Оператор: не назначен',
    `Создан: ${current.created_at || '—'}`,
    `Канал: ${source}`,
    `ID: ${current.id}`
  ].join('\n');
}

async function sendRichOrText(chatId, markdown, options, fallbackText) {
  if (!tgEnabled()) return null;
  if (richMessagesAvailable && typeof bot.sendRichMessage === 'function') {
    try {
      return await bot.sendRichMessage(chatId, { markdown }, options);
    } catch (error) {
      const description = tgError(error).toLowerCase();
      if (description.includes('method not found') || description.includes('rich')) {
        richMessagesAvailable = false;
      }
      console.warn('[TG private] Rich message fallback:', tgError(error));
    }
  }
  return bot.sendMessage(chatId, fallbackText, options);
}

async function editRichOrDisable(chatId, messageId, markdown, replyMarkup, fallbackText) {
  try {
    if (richMessagesAvailable) {
      return await bot.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        rich_message: { markdown },
        reply_markup: replyMarkup
      });
    }
    return await bot.editMessageText(fallbackText, {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup
    });
  } catch (error) {
    try {
      await bot.editMessageReplyMarkup(replyMarkup, { chat_id: chatId, message_id: messageId });
    } catch {}
    console.warn('[TG private] Notification edit:', tgError(error));
    return null;
  }
}

async function operationalAlert(key, text, details = '') {
  const settings = loadSettings();
  if (!settings.operationalAlertsEnabled) return;
  const now = Date.now();
  const cooldownMs = Number(settings.operationalAlertCooldownMinutes || 15) * 60 * 1000;
  if (now - (alertTimes.get(key) || 0) < cooldownMs) return;
  alertTimes.set(key, now);
  console.error(`[Monitor] ${text}`, details);
  io?.to('admin').emit('operational_alert', {
    key,
    message: text,
    details,
    createdAt: new Date().toISOString()
  });
  if (!bot) return;
  const operators = db.getActiveTelegramOperators.all()
    .filter(operator => isAuthorized(operator.telegram_user_id));
  await Promise.allSettled(operators.map(operator => bot.sendMessage(
    operator.telegram_user_id,
    `🚨 <b>Контроль доставки чата</b>\n${htmlEscape(text)}${details ? `\n<code>${htmlEscape(details).slice(0, 1500)}</code>` : ''}`,
    { parse_mode: 'HTML' }
  )));
}

function init(socketIo, hooks = {}) {
  io = socketIo;
  lifecycle = hooks || {};
  if (!TOKEN) {
    console.warn('[TG private] TELEGRAM_BOT_TOKEN not set — disabled');
    return null;
  }
  if (!ADMIN_IDS.size) {
    console.warn('[TG private] TELEGRAM_ADMIN_IDS not set — customer channel only');
  }
  pollingLease = createTelegramPollingLease({
    database: db,
    logPrefix: '[TG private]',
    onAcquired: startBot,
    onLost: stopBot
  });
  pollingLease.start();
  deliveryTimer = backgroundTimer(setInterval(processDeliveryQueue, 15 * 1000));
  scheduleDeliveryQueue(1000);
  backgroundTimer(setInterval(reconcileUnassignedTickets, 60 * 1000));
  backgroundTimer(setTimeout(reconcileUnassignedTickets, 10000));
  reminderTimer = backgroundTimer(setInterval(processUnansweredReminders, 30 * 1000));
  backgroundTimer(setTimeout(processUnansweredReminders, 20000));
  backgroundTimer(setInterval(cleanupOldTopics, 60 * 60 * 1000));
  backgroundTimer(setTimeout(cleanupOldTopics, 15000));
  return bot;
}

async function startBot() {
  if (bot) return bot;
  console.log('[TG private] Starting...');
  let instance = null;
  try {
    instance = new TelegramBot(TOKEN, {
      polling: {
        interval: POLLING_INTERVAL_MS,
        autoStart: false,
        params: {
          timeout: 30,
          allowed_updates: ['message', 'callback_query', 'message_reaction', 'message_reaction_count']
        }
      }
    });
    bot = instance;
    instance.on('polling_error', error => {
      if (instance !== bot) return;
      connected = false;
      if (isPollingConflict(error)) {
        reportPollingConflict(error);
        return;
      }
      const notify = recordPollingError(error);
      console.error(
        `[TG private] Polling (${pollingStats.consecutiveErrors}/${POLLING_ALERT_AFTER_ERRORS}):`,
        tgError(error)
      );
      if (notify) {
        operationalAlert('telegram-polling', 'Потеряно соединение с Telegram', tgError(error)).catch(() => {});
      }
    });
    instance.on('error', error => {
      if (instance !== bot) return;
      console.error('[TG private] Error:', tgError(error));
    });
    instance.on('message', handleMessage);
    instance.on('callback_query', query => { resetPollingErrors(); return handleCallbackQuery(query); });
    instance.on('message_reaction', update => { resetPollingErrors(); return handleMessageReaction(update); });
    instance.on('message_reaction_count', update => { resetPollingErrors(); return handleMessageReactionCount(update); });
    await instance.startPolling();
    await configureBot(instance);
    return instance;
  } catch (error) {
    if (bot === instance) bot = null;
    await instance?.stopPolling?.({ cancel: true, reason: 'Polling startup failed' }).catch(() => {});
    console.error('[TG private] Failed to start:', tgError(error));
    throw error;
  }
}

async function stopBot(reason = 'lease-lost') {
  const previous = bot;
  bot = null;
  connected = false;
  if (previous) {
    await previous.stopPolling({ cancel: true, reason }).catch(() => {});
  }
}

async function configureBot(instance = bot) {
  if (!instance) return;
  const me = await instance.getMe();
  if (instance !== bot) return;
  connected = true;
  resetPollingErrors();
  botUsername = me.username || '';
  threadedModeEnabled = !!me.has_topics_enabled;
  const customerCommands = [
    { command: 'start', description: 'Создать тикет' },
    { command: 'new', description: 'Создать новый тикет' },
    { command: 'status', description: 'Статус тикета' },
    { command: 'close', description: 'Закрыть тикет' }
  ];
  const operatorCommands = [
    { command: 'start', description: 'Открыть операторскую консоль' },
    { command: 'queue', description: 'Открыть панель оператора' },
    { command: 'waiting', description: 'Новые тикеты' },
    { command: 'open', description: 'Мои открытые тикеты' },
    { command: 'closed', description: 'Мои закрытые тикеты' },
    { command: 'admin', description: 'Открыть админку' },
    { command: 'close', description: 'Закрыть текущий тикет' },
    { command: 'reopen', description: 'Переоткрыть текущий тикет' }
  ];
  await instance.setMyCommands(customerCommands).catch(() => {});
  for (const operatorId of ADMIN_IDS) {
    await instance.setMyCommands(operatorCommands, {
      scope: { type: 'chat', chat_id: operatorId }
    }).catch(() => {});
  }
  const webAppUrl = adminWebAppUrl();
  await instance.setChatMenuButton({
    menu_button: { type: 'commands' }
  }).catch(() => {});
  if (webAppUrl) {
    for (const operatorId of ADMIN_IDS) {
      await instance.setChatMenuButton({
        chat_id: operatorId,
        menu_button: { type: 'web_app', text: 'Админка', web_app: { url: webAppUrl } }
      }).catch(() => {});
    }
  }
  console.log(`[TG private] Connected as @${botUsername || 'bot'}; threaded=${threadedModeEnabled}`);
}

function registerOperator(from) {
  if (!isAuthorized(from?.id)) return null;
  db.upsertTelegramOperator.run(
    String(from.id),
    operatorName(from),
    from.username || null
  );
  return db.getTelegramOperator.get(String(from.id));
}

async function sendDashboard(operator) {
  const model = dashboardModel(operator);
  return sendRichOrText(
    operator.telegram_user_id,
    model.markdown,
    { reply_markup: model.replyMarkup },
    model.fallback
  );
}

async function sendTicketList(operator, view, page = 0) {
  const model = ticketListModel(operator, view, page);
  return sendRichOrText(
    operator.telegram_user_id,
    model.markdown,
    { reply_markup: model.replyMarkup },
    model.fallback
  );
}

async function handleStart(msg) {
  if (!isAuthorized(msg.from?.id)) {
    await bot.sendMessage(msg.chat.id, '⛔ У вас нет доступа к операторской консоли.').catch(() => {});
    return;
  }
  const operator = registerOperator(msg.from);
  await sendDashboard(operator);
  await reconcileOperator(operator);
}

function customerKeyboard(ticket) {
  const settings = cfg();
  const rows = [];
  if (ticket?.status === 'open') {
    rows.push([{
      text: settings.telegramCustomerCloseButtonText,
      callback_data: 'customer:close'
    }]);
  } else {
    rows.push([{
      text: settings.telegramCustomerNewButtonText,
      callback_data: 'customer:new'
    }]);
  }
  return { inline_keyboard: rows };
}

function customerControlModel(ticket, reason = '') {
  const settings = cfg();
  const values = {
    name: ticket.user_name || 'Клиент',
    shortId: shortId(ticket),
    id: ticket.id,
    reason
  };
  if (ticket.status === 'closed') {
    const body = formatTemplate(settings.telegramCustomerClosedText, values);
    const reasonLine = reason && !settings.telegramCustomerClosedText.includes('{reason}')
      ? `\n\n**Причина:** ${reason}`
      : '';
    const fallbackReason = reason && !settings.telegramCustomerClosedText.includes('{reason}')
      ? `\n\nПричина: ${reason}`
      : '';
    return {
      markdown: [
        `## ✅ Тикет #${markdownEscape(shortId(ticket))} закрыт`,
        '',
        `${body}${reasonLine}`
      ].join('\n'),
      fallback: [`✅ Тикет #${shortId(ticket)} закрыт`, '', `${body}${fallbackReason}`].join('\n')
    };
  }
  const body = formatTemplate(settings.telegramCustomerNewTicketText, values);
  return {
    markdown: [
      `## 🎫 Тикет #${markdownEscape(shortId(ticket))} создан`,
      '',
      body,
      '',
      `**Статус:** открыт`
    ].join('\n'),
    fallback: [`🎫 Тикет #${shortId(ticket)} создан`, '', body, '', 'Статус: открыт'].join('\n')
  };
}

async function pinCustomerControl(chatId, messageId, { repin = false } = {}) {
  if (repin && typeof bot.unpinChatMessage === 'function') {
    await bot.unpinChatMessage(chatId, { message_id: messageId }).catch(() => {});
  }
  await bot.pinChatMessage(chatId, messageId, {
    disable_notification: !repin
  }).catch(error => {
    console.warn('[TG private] customer control pin:', tgError(error));
  });
}

async function deleteTelegramMessage(chatId, messageId) {
  if (!messageId || typeof bot.deleteMessage !== 'function') return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await bot.deleteMessage(chatId, Number(messageId));
      return true;
    } catch (error) {
      const message = tgError(error).toLowerCase();
      if (message.includes('message to delete not found') ||
          message.includes('message_id_invalid')) {
        return true;
      }
      if (attempt < 3) {
        await wait(150 * attempt);
        continue;
      }
      console.warn('[TG private] message cleanup:', tgError(error));
    }
  }
  return false;
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

async function handleTelegramServiceMessage(msg) {
  if (!isDisposableTelegramServiceMessage(msg)) return false;
  if (cfg().telegramDeleteRenameNotices) {
    await deleteTelegramMessage(msg.chat.id, msg.message_id);
  }
  return true;
}

function trackCustomerChatMessage(ticket, message) {
  if (!ticket?.id || !ticket.telegram_customer_chat_id || !message?.message_id) return;
  db.trackTelegramCustomerChatMessage.run(
    ticket.id,
    String(ticket.telegram_customer_chat_id),
    Number(message.message_id)
  );
}

async function sendCustomerRichNotice(ticket, markdown, fallback, options = {}) {
  const sent = await sendRichOrText(
    String(ticket.telegram_customer_chat_id),
    markdown,
    options,
    fallback
  );
  trackCustomerChatMessage(ticket, sent);
  return sent;
}

async function removeCustomerControl(ticket) {
  const fresh = db.getTicketById.get(ticket?.id) || ticket;
  const chatId = String(fresh?.telegram_customer_chat_id || '');
  const messageId = Number(fresh?.telegram_customer_control_message_id || 0);
  if (!chatId || !messageId) return;
  if (typeof bot.unpinChatMessage === 'function') {
    await bot.unpinChatMessage(chatId, { message_id: messageId }).catch(() => {});
  }
  await deleteTelegramMessage(chatId, messageId);
  db.clearTelegramCustomerControlMessage.run(fresh.id, messageId);
}

async function ensureCustomerControlMessage(ticket, {
  repin = false,
  forceNew = false,
  preserveExisting = false,
  reason = ''
} = {}) {
  const fresh = db.getTicketById.get(ticket?.id);
  if (!tgEnabled() || fresh?.source !== 'telegram' || !fresh.telegram_customer_chat_id) {
    return null;
  }
  if (customerControlMessages.has(fresh.id)) {
    return customerControlMessages.get(fresh.id);
  }
  const task = (async () => {
    const chatId = String(fresh.telegram_customer_chat_id);
    const model = customerControlModel(fresh, reason);
    const replyMarkup = customerKeyboard(fresh);
    let controlMessageId = Number(fresh.telegram_customer_control_message_id || 0) || null;
    if (preserveExisting && controlMessageId) {
      await pinCustomerControl(chatId, controlMessageId, { repin });
      return controlMessageId;
    }
    if (forceNew && controlMessageId) {
      await removeCustomerControl(fresh);
      controlMessageId = null;
    }
    if (controlMessageId) {
      const edited = await editRichOrDisable(
        chatId,
        controlMessageId,
        model.markdown,
        replyMarkup,
        model.fallback
      );
      if (!edited) {
        db.clearTelegramCustomerControlMessage.run(fresh.id, controlMessageId);
        controlMessageId = null;
      }
    }
    if (!controlMessageId) {
      const sent = await sendRichOrText(
        chatId,
        model.markdown,
        { reply_markup: replyMarkup, disable_notification: false },
        model.fallback
      );
      if (!sent?.message_id) throw new Error('Telegram did not confirm ticket control message');
      controlMessageId = sent.message_id;
      db.setTelegramCustomerControlMessage.run(controlMessageId, fresh.id);
    }
    await pinCustomerControl(chatId, controlMessageId, { repin });
    return controlMessageId;
  })().finally(() => customerControlMessages.delete(fresh.id));
  customerControlMessages.set(fresh.id, task);
  return task;
}

async function clearCustomerTicketChat(ticket, { extraMessageIds = [] } = {}) {
  const fresh = db.getTicketById.get(ticket?.id) || ticket;
  if (fresh?.source !== 'telegram' || !fresh.telegram_customer_chat_id) return;
  const chatId = String(fresh.telegram_customer_chat_id);
  const ids = new Set(extraMessageIds.map(Number).filter(Boolean));
  const controlMessageId = Number(fresh.telegram_customer_control_message_id || 0);
  if (controlMessageId) ids.add(controlMessageId);
  for (const message of db.getMessages.all(fresh.id)) {
    if (message.telegram_source_message_id) ids.add(Number(message.telegram_source_message_id));
    if (message.telegram_customer_message_id) ids.add(Number(message.telegram_customer_message_id));
  }
  for (const message of db.getTelegramCustomerChatMessages.all(fresh.id)) {
    if (message.message_id) ids.add(Number(message.message_id));
  }
  if (controlMessageId && typeof bot.unpinChatMessage === 'function') {
    await bot.unpinChatMessage(chatId, { message_id: controlMessageId }).catch(() => {});
  }
  const orderedIds = [...ids].sort((a, b) => b - a);
  const failed = [];
  for (let index = 0; index < orderedIds.length; index += 10) {
    const batch = orderedIds.slice(index, index + 10);
    const results = await Promise.all(batch.map(messageId =>
      deleteTelegramMessage(chatId, messageId)
    ));
    results.forEach((ok, resultIndex) => {
      if (!ok) failed.push(batch[resultIndex]);
    });
  }
  if (controlMessageId) {
    db.clearTelegramCustomerControlMessage.run(fresh.id, controlMessageId);
  }
  db.clearTelegramCustomerChatMessages.run(fresh.id);
  if (failed.length) {
    const details = `Не удалены сообщения: ${failed.join(', ')}`;
    deliveryStats.lastError = `Очистка чата ${shortId(fresh)}: ${details}`;
    console.warn(`[TG private] Не удалось полностью очистить чат тикета ${shortId(fresh)}. ${details}`);
    io?.to('admin').emit('operational_alert', {
      key: `tg-customer-cleanup-${fresh.id}`,
      message: `Не удалось полностью очистить чат тикета ${shortId(fresh)}`,
      details,
      createdAt: new Date().toISOString()
    });
  }
}

async function showClosedCustomerLauncher(ticket, reason, options = {}) {
  const fresh = db.getTicketById.get(ticket?.id) || ticket;
  if (fresh?.source !== 'telegram' || !fresh.telegram_customer_chat_id) return null;
  closingCustomerTickets.add(fresh.id);
  try {
    await customerControlMessages.get(fresh.id)?.catch(() => {});
    await clearCustomerTicketChat(fresh, options);
    return await ensureCustomerControlMessage(fresh, {
      forceNew: true,
      repin: true,
      reason
    });
  } finally {
    closingCustomerTickets.delete(fresh.id);
  }
}

async function sendCustomerControl(ticket, options = {}) {
  return ensureCustomerControlMessage(ticket, {
    ...options,
    forceNew: true,
    repin: true
  });
}

async function removePreviousCustomerLauncher(customerId) {
  const latest = db.getLatestTicketByTelegramCustomer.get(String(customerId));
  if (latest?.status === 'closed') {
    await clearCustomerTicketChat(latest);
  }
}

async function startCustomerTicketExperience(ticket, { replaceMessageId = null } = {}) {
  if (replaceMessageId) {
    await deleteTelegramMessage(String(ticket.telegram_customer_chat_id), replaceMessageId);
  }
  await ensureCustomerControlMessage(ticket, { forceNew: true });
  lifecycle.scheduleWelcomeMessages?.(ticket.id);
  createTopic(ticket.id).catch(error => {
    console.error('[TG private] customer topic:', tgError(error));
  });
}

function updateCustomerProfile(from, chatId) {
  const telegramId = String(from?.id || '');
  if (!telegramId) return;
  db.updateTelegramCustomerProfile.run(
    customerName(from),
    String(chatId || telegramId),
    from?.username || null,
    from?.first_name || null,
    from?.last_name || null,
    from?.language_code || null,
    telegramId
  );
}

function createCustomerTicket(from, chatId) {
  const ticketId = uuidv4();
  db.createTelegramTicket.run(
    ticketId,
    customerName(from),
    uuidv4(),
    String(from.id),
    String(chatId || from.id),
    from.username || null,
    from.first_name || null,
    from.last_name || null,
    from.language_code || null
  );
  const ticket = db.getTicketById.get(ticketId);
  io?.to('admin').emit('admin_new_ticket', ticket);
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  return ticket;
}

async function ensureCustomerTicket(msg, { forceNew = false } = {}) {
  const customerId = String(msg.from.id);
  let ticket = db.getOpenTicketByTelegramCustomer.get(customerId);
  if (ticket && !forceNew) {
    updateCustomerProfile(msg.from, msg.chat.id);
    return { ticket: db.getTicketById.get(ticket.id), created: false, reopened: false };
  }
  if (ticket && forceNew) {
    return { ticket: db.getTicketById.get(ticket.id), created: false, reopened: false };
  }

  await removePreviousCustomerLauncher(customerId);
  ticket = createCustomerTicket(msg.from, msg.chat.id);
  return { ticket, created: true, reopened: false };
}

function customerRateLimited(customerId) {
  const now = Date.now();
  const limit = Number(cfg().messageRateLimitPerMinute || 20);
  let rate = customerMessageRates.get(customerId);
  if (!rate || now >= rate.resetAt) {
    rate = { count: 0, resetAt: now + 60 * 1000 };
    customerMessageRates.set(customerId, rate);
  }
  rate.count++;
  return rate.count > limit;
}

async function closeCustomerTicket(msg) {
  const ticket = db.getOpenTicketByTelegramCustomer.get(String(msg.from.id));
  if (!ticket) {
    await deleteTelegramMessage(msg.chat.id, msg.message_id);
    const latest = db.getLatestTicketByTelegramCustomer.get(String(msg.from.id));
    if (latest) {
      await ensureCustomerControlMessage(latest, {
        preserveExisting: true,
        repin: true
      }).catch(() => {});
    }
    return;
  }
  db.closeTicket.run(ticket.id);
  lifecycle.cancelOperatorWait?.(ticket.id);
  await notifyTicketClosed(ticket, {
    customerReason: cfg().telegramCustomerClosedByUserText,
    extraMessageIds: [msg.message_id]
  });
  io?.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'user' });
  io?.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
}

async function handleCustomerStart(msg) {
  if (!cfg().telegramCustomerEnabled) {
    await sendRichOrText(
      msg.chat.id,
      '## ⏸ Поддержка временно недоступна\n\nСоздание тикетов через Telegram сейчас отключено.',
      {},
      'Поддержка временно недоступна. Создание тикетов через Telegram сейчас отключено.'
    ).catch(() => {});
    return;
  }
  let ticket = db.getOpenTicketByTelegramCustomer.get(String(msg.from.id));
  if (ticket) {
    updateCustomerProfile(msg.from, msg.chat.id);
    await deleteTelegramMessage(msg.chat.id, msg.message_id);
    await ensureCustomerControlMessage(ticket, { forceNew: true, repin: true }).catch(() => {});
    return;
  }
  const result = await ensureCustomerTicket(msg, { forceNew: true });
  ticket = result.ticket;
  await startCustomerTicketExperience(ticket, { replaceMessageId: msg.message_id });
}

async function handleCustomerMessage(msg) {
  const settings = cfg();
  if (!settings.telegramCustomerEnabled) {
    await sendRichOrText(
      msg.chat.id,
      '## ⏸ Поддержка временно недоступна\n\nСоздание тикетов через Telegram сейчас отключено.',
      {},
      'Поддержка временно недоступна. Создание тикетов через Telegram сейчас отключено.'
    ).catch(() => {});
    return;
  }
  const command = parseCommand(msg.text || msg.caption);
  if (command === '/start') return handleCustomerStart(msg);
  if (command === '/status') {
    const ticket = db.getOpenTicketByTelegramCustomer.get(String(msg.from.id));
    await deleteTelegramMessage(msg.chat.id, msg.message_id);
    if (ticket) return ensureCustomerControlMessage(ticket, { forceNew: true, repin: true });
    const latest = db.getLatestTicketByTelegramCustomer.get(String(msg.from.id));
    if (latest) {
      return ensureCustomerControlMessage(latest, {
        preserveExisting: true,
        repin: true
      });
    }
    return handleCustomerStart(msg);
  }
  if (command === '/close') return closeCustomerTicket(msg);
  if (command === '/new') {
    const existing = db.getOpenTicketByTelegramCustomer.get(String(msg.from.id));
    if (existing) {
      await deleteTelegramMessage(msg.chat.id, msg.message_id);
      return ensureCustomerControlMessage(existing, { forceNew: true, repin: true });
    }
    const result = await ensureCustomerTicket(msg, { forceNew: true });
    await startCustomerTicketExperience(result.ticket, { replaceMessageId: msg.message_id });
    return;
  }
  if (command) {
    await deleteTelegramMessage(msg.chat.id, msg.message_id);
    const ticket = db.getOpenTicketByTelegramCustomer.get(String(msg.from.id));
    if (ticket) return ensureCustomerControlMessage(ticket, { forceNew: true, repin: true });
    return handleCustomerStart(msg);
  }
  const currentTicket = db.getOpenTicketByTelegramCustomer.get(String(msg.from.id));
  if (customerRateLimited(String(msg.from.id))) {
    const markdown = '## ⏳ Слишком много сообщений\n\nПодождите минуту и попробуйте снова.';
    const fallback = 'Слишком много сообщений. Подождите минуту и попробуйте снова.';
    return currentTicket
      ? sendCustomerRichNotice(currentTicket, markdown, fallback)
      : sendRichOrText(msg.chat.id, markdown, {}, fallback);
  }

  const hasFile = !!(msg.photo || msg.video || msg.document || msg.voice || msg.audio || msg.animation || msg.video_note);
  if (hasFile && !settings.telegramCustomerFilesEnabled) {
    const markdown = '## 📎 Файлы временно отключены\n\nОтправьте вопрос текстом.';
    const fallback = 'Отправка файлов через Telegram сейчас отключена. Отправьте вопрос текстом.';
    return currentTicket
      ? sendCustomerRichNotice(currentTicket, markdown, fallback)
      : sendRichOrText(msg.chat.id, markdown, {}, fallback);
  }
  const rawText = String(msg.text || msg.caption || '').trim() || null;
  let type = 'text';
  let fileUrl = null;
  let fileName = null;
  let fileMime = null;
  if (hasFile) {
    const file = await downloadFile(msg);
    if (!file) {
      deliveryStats.mediaFailures++;
      await operationalAlert(
        `tg-customer-media-${msg.from.id}`,
        'Не удалось получить файл клиента из Telegram',
        `Telegram user_id=${msg.from.id}; message_id=${msg.message_id}`
      );
      const markdown = '## ⚠️ Файл не загрузился\n\nПопробуйте ещё раз или отправьте его как документ.';
      const fallback = 'Не удалось загрузить файл. Попробуйте ещё раз или отправьте его как документ.';
      return currentTicket
        ? sendCustomerRichNotice(currentTicket, markdown, fallback)
        : sendRichOrText(msg.chat.id, markdown, {}, fallback);
    }
    fileUrl = file.url;
    fileName = file.name;
    fileMime = file.mime;
    type = file.type;
  }
  if (!rawText && !fileUrl) return;

  if (db.getMessageByTelegramSource.get(String(msg.chat.id), msg.message_id)) {
    deliveryStats.incomingDuplicates++;
    return;
  }
  const result = await ensureCustomerTicket(msg);
  const ticket = result.ticket;
  if (result.created) {
    await startCustomerTicketExperience(ticket);
  }
  let replyToId = null;
  if (msg.reply_to_message?.message_id) {
    const reply = db.getMessageByTelegramCustomerDelivery.get(
      ticket.id,
      msg.reply_to_message.message_id
    );
    if (reply) replyToId = reply.id;
  }
  const id = uuidv4();
  db.saveMessage.run(
    id,
    ticket.id,
    'user',
    ticket.user_name,
    rawText,
    type,
    fileUrl,
    fileName,
    fileMime,
    null,
    replyToId
  );
  db.setTelegramMessageSource.run(String(msg.chat.id), msg.message_id, id);
  const message = {
    id,
    ticket_id: ticket.id,
    sender: 'user',
    sender_name: ticket.user_name,
    content: rawText,
    message_type: type,
    file_url: fileUrl,
    file_name: fileName,
    file_mime: fileMime,
    created_at: new Date().toISOString(),
    reply_to_id: replyToId
  };
  io?.to(`ticket:${ticket.id}`).emit('message', message);
  io?.to('admin').emit('admin_new_message', { ticketId: ticket.id, message });
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  lifecycle.scheduleOperatorWaitMessage?.(ticket.id, id);
  await forwardMessage(ticket, message).catch(error => {
    console.error('[TG private] customer forwarding:', tgError(error));
  });
}

async function registeredAuthorizedOperators({ discover = false } = {}) {
  let operators = db.getActiveTelegramOperators.all()
    .filter(operator => isAuthorized(operator.telegram_user_id));
  if (!discover || operators.length || !bot) return operators;

  for (const telegramUserId of ADMIN_IDS) {
    try {
      const chat = await bot.getChat(telegramUserId);
      if (chat?.type !== 'private') continue;
      db.upsertTelegramOperator.run(
        String(telegramUserId),
        operatorName(chat),
        chat.username || null
      );
    } catch (error) {
      console.warn(`[TG private] operator discovery ${telegramUserId}:`, tgError(error));
    }
  }
  operators = db.getActiveTelegramOperators.all()
    .filter(operator => isAuthorized(operator.telegram_user_id));
  return operators;
}

function parseDatabaseTime(value) {
  const raw = String(value || '');
  if (!raw) return new Date(NaN);
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw);
}

async function processUnansweredReminders() {
  const settings = cfg();
  if (!tgEnabled() || !settings.telegramUnansweredReminderEnabled || reminderRunning) return 0;
  reminderRunning = true;
  try {
    const tickets = db.getTicketsAwaitingTelegramReminder.all(
      `-${settings.telegramUnansweredReminderMinutes} minutes`,
      `-${settings.telegramUnansweredRepeatMinutes} minutes`,
      50
    );
    if (!tickets.length) return 0;

    const operators = await registeredAuthorizedOperators({ discover: true });
    let sentCount = 0;
    for (const ticket of tickets) {
      const assigned = operators.find(operator =>
        String(operator.telegram_user_id) === String(ticket.assigned_operator_id || '')
      );
      const targets = assigned ? [assigned] : operators;
      if (!targets.length) {
        reminderStats.failed++;
        reminderStats.lastError = `No registered operator for ${shortId(ticket)}`;
        continue;
      }

      const waitingSince = parseDatabaseTime(ticket.waiting_since);
      const waitingMinutes = Math.max(
        1,
        Math.floor((Date.now() - waitingSince.getTime()) / 60000)
      );
      const assignment = assigned
        ? `Назначен: ${assigned.display_name}`
        : ticket.assigned_operator_id
          ? 'Назначенный оператор недоступен — требуется вмешательство'
          : 'Никто не взял тикет';
      const text = [
        `⏰ <b>Тикет ждёт ответа ${waitingMinutes} мин</b>`,
        `👤 ${htmlEscape(ticket.user_name || 'Клиент')} · <code>${htmlEscape(shortId(ticket))}</code>`,
        htmlEscape(assignment),
        '',
        'Откройте тикет и ответьте клиенту.'
      ].join('\n');
      const results = await Promise.allSettled(targets.map(operator => bot.sendMessage(
        operator.telegram_user_id,
        text,
        {
          parse_mode: 'HTML',
          disable_notification: false,
          reply_markup: ticketKeyboard(ticket, ticket.assigned_operator_id ? 'open' : 'unassigned')
        }
      )));
      const delivered = results.some(result => result.status === 'fulfilled');
      if (!delivered) {
        reminderStats.failed++;
        reminderStats.lastError = results
          .filter(result => result.status === 'rejected')
          .map(result => tgError(result.reason))
          .join('; ') || `Reminder failed for ${shortId(ticket)}`;
        await operationalAlert(
          `telegram-reminder-${ticket.id}`,
          `Не доставлено напоминание по тикету ${shortId(ticket)}`,
          reminderStats.lastError
        );
        continue;
      }
      db.markTelegramTicketReminded.run(ticket.id);
      reminderStats.sent++;
      reminderStats.lastSentAt = new Date().toISOString();
      sentCount++;
      io?.to('admin').emit('ticket_reminder', {
        ticketId: ticket.id,
        waitingMinutes,
        assigned: !!assigned
      });
    }
    return sentCount;
  } catch (error) {
    reminderStats.failed++;
    reminderStats.lastError = tgError(error);
    console.error('[TG private] unanswered reminder:', reminderStats.lastError);
    return 0;
  } finally {
    reminderRunning = false;
  }
}

async function reportAssignmentFailure(ticket, operator, error) {
  const details = `Тикет ${shortId(ticket)}, оператор ${operator?.display_name || operator?.telegram_user_id || 'неизвестен'}: ${tgError(error)}`;
  await operationalAlert(
    `telegram-autoassign-${ticket.id}`,
    'Не удалось автоматически назначить новый тикет',
    details
  );
  if (operator?.telegram_user_id) {
    await bot.sendMessage(
      operator.telegram_user_id,
      `⚠️ Новый тикет ${shortId(ticket)} не назначился автоматически.\nОткройте /queue и возьмите его вручную.`,
      { disable_notification: false }
    ).catch(() => {});
  }
}

async function autoAssignTicket(ticket, operator, options = {}) {
  if (assigningTickets.has(ticket.id)) return assigningTickets.get(ticket.id);
  const assignment = (async () => {
    await sendAssignmentNotification(ticket, operator, {
      forceNew: false,
      message: options.message
    }).catch(error => {
      console.warn('[TG private] new ticket notification:', tgError(error));
    });
    try {
      return await claimAndOpenTicket(ticket.id, operator.telegram_user_id, {
        replay: options.replay
      });
    } catch (error) {
      if (!options.suppressFailureReport) {
        await reportAssignmentFailure(ticket, operator, error);
      }
      throw error;
    }
  })().finally(() => assigningTickets.delete(ticket.id));
  assigningTickets.set(ticket.id, assignment);
  return assignment;
}

async function reconcileOperator(operator) {
  const tickets = db.getOpenUnassignedTickets.all(50);
  const operators = await registeredAuthorizedOperators();
  if (!cfg().telegramAutoAssignSingleOperator ||
      operators.length !== 1 ||
      String(operators[0].telegram_user_id) !== String(operator.telegram_user_id)) return;
  for (const ticket of tickets) {
    await autoAssignTicket(ticket, operator).catch(() => {});
    await wait(150);
  }
}

async function reconcileUnassignedTickets() {
  if (!tgEnabled()) return;
  const operators = await registeredAuthorizedOperators({ discover: true });
  if (!operators.length) {
    const waiting = db.getOpenUnassignedTickets.all(1);
    if (waiting.length) {
      await operationalAlert(
        'telegram-no-operators',
        'Есть тикеты, но ни один Telegram-оператор не зарегистрирован',
        'Каждый оператор из TELEGRAM_ADMIN_IDS должен открыть личный чат с ботом и выполнить /start.'
      );
    }
    return;
  }
  const stranded = db.getOpenAssignedTicketsWithoutPrivateThread.all(50);
  for (const ticket of stranded) {
    const operator = operators.find(item =>
      String(item.telegram_user_id) === String(ticket.assigned_operator_id)
    );
    if (!operator) {
      db.unassignTicket.run(ticket.id);
      continue;
    }
    await claimAndOpenTicket(ticket.id, operator.telegram_user_id).catch(error => {
      console.warn(`[TG private] restore thread ${shortId(ticket)}:`, tgError(error));
    });
    await wait(150);
  }
  const tickets = db.getOpenUnassignedTickets.all(50);
  for (const ticket of tickets) {
    if (operators.length === 1 && cfg().telegramAutoAssignSingleOperator) {
      await autoAssignTicket(ticket, operators[0]).catch(() => {});
    } else {
      for (const operator of operators) {
        await sendAssignmentNotification(ticket, operator, { forceNew: false });
      }
    }
    await wait(200);
  }
}

async function sendAssignmentNotification(ticket, operator, options = {}) {
  if (!operator || !isAuthorized(operator.telegram_user_id)) return null;
  const fresh = db.getTicketById.get(ticket.id);
  if (!fresh || fresh.status !== 'open' || fresh.assigned_operator_id) return null;
  const existing = db.getTelegramNotification.get(ticket.id, operator.telegram_user_id);
  const markdown = ticketRichMarkdown(fresh, 'unassigned', { message: options.message });
  const fallback = ticketFallbackText(fresh, 'unassigned', { message: options.message });
  if (existing && !options.forceNew) {
    await editRichOrDisable(
      existing.chat_id,
      existing.message_id,
      markdown,
      ticketKeyboard(fresh, 'unassigned'),
      fallback
    );
    return existing.message_id;
  }
  if (existing) {
    await editRichOrDisable(
      existing.chat_id,
      existing.message_id,
      ticketRichMarkdown(fresh, 'assigned', { operatorName: 'обновлено' }),
      { inline_keyboard: [] },
      `${fallback}\n\nКарточка обновлена ниже.`
    );
  }
  const sent = await sendRichOrText(
    operator.telegram_user_id,
    markdown,
    {
      reply_markup: ticketKeyboard(fresh, 'unassigned'),
      disable_notification: false
    },
    fallback
  );
  if (sent) {
    db.saveTelegramNotification.run(
      fresh.id,
      operator.telegram_user_id,
      String(operator.telegram_user_id),
      sent.message_id,
      'open'
    );
  }
  return sent?.message_id || null;
}

async function updateAssignmentNotifications(ticket, assignedOperator) {
  const notifications = db.getTelegramNotificationsForTicket.all(ticket.id);
  const state = ticket.status === 'closed' ? 'closed' : 'assigned';
  const operatorLabel = assignedOperator?.display_name || 'оператор';
  await Promise.allSettled(notifications.map(notification => {
    const belongsToAssignee =
      notification.operator_id === String(assignedOperator?.telegram_user_id || '');
    const keyboard = belongsToAssignee
      ? ticketKeyboard(ticket, state === 'closed' ? 'closed' : 'open')
      : { inline_keyboard: [] };
    return editRichOrDisable(
      notification.chat_id,
      notification.message_id,
      ticketRichMarkdown(ticket, state, { operatorName: operatorLabel }),
      keyboard,
      ticketFallbackText(ticket, state, { operatorName: operatorLabel })
    );
  }));
  db.updateTelegramNotificationState.run(state, ticket.id);
}

async function claimAndOpenTicket(ticketId, operatorId, options = {}) {
  const operator = db.getTelegramOperator.get(String(operatorId));
  if (!operator || !operator.active || !isAuthorized(operator.telegram_user_id)) {
    throw new Error('Operator is not registered');
  }
  const before = db.getTicketById.get(ticketId);
  if (!before || before.status !== 'open') throw new Error('Ticket is not open');
  const assignedHere = !before.assigned_operator_id;
  if (assignedHere) {
    db.assignTicketIfUnassigned.run(operator.telegram_user_id, ticketId);
  }
  const ticket = db.getTicketById.get(ticketId);
  if (String(ticket.assigned_operator_id || '') !== String(operator.telegram_user_id)) {
    const owner = db.getTelegramOperator.get(String(ticket.assigned_operator_id || ''));
    const error = new Error(`Тикет уже взял ${owner?.display_name || 'другой оператор'}`);
    error.alreadyAssigned = true;
    throw error;
  }
  let thread;
  try {
    thread = await ensurePrivateThread(ticket, operator);
  } catch (error) {
    if (assignedHere) {
      db.unassignTicket.run(ticket.id);
      io?.to('admin').emit('admin_ticket_updated', db.getTicketById.get(ticket.id));
      io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
    }
    throw error;
  }
  updateAssignmentNotifications(ticket, operator).catch(error => {
    console.warn('[TG private] assignment notification update:', tgError(error));
  });
  if (thread && options.replay !== false) {
    replayUnsentMessages(ticket, 10).catch(error => {
      console.warn('[TG private] history replay:', tgError(error));
    });
  } else if (thread) {
    scheduleDeliveryQueue(1000);
  }
  io?.to('admin').emit('admin_ticket_updated', db.getTicketById.get(ticket.id));
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  return thread;
}

async function ensurePrivateThread(ticket, operator) {
  const existing = db.getTelegramThreadForTicketOperator.get(ticket.id, operator.telegram_user_id);
  if (existing) return existing;
  const key = `${ticket.id}:${operator.telegram_user_id}`;
  if (creatingThreads.has(key)) return creatingThreads.get(key);
  const startedAt = Date.now();
  const promise = (async () => {
    if (!threadedModeEnabled) {
      await bot.sendMessage(
        operator.telegram_user_id,
        `⚠️ Не могу создать тему тикета ${shortId(ticket)}. Включите Threaded Mode у бота через @BotFather.`
      ).catch(() => {});
      await operationalAlert(
        'telegram-threaded-mode-disabled',
        'У Telegram-бота выключен Threaded Mode',
        'Включите Threaded Mode в настройках бота у @BotFather.'
      );
      throw new Error('Telegram private Threaded Mode is disabled');
    }
    const settings = cfg();
    const topic = await bot.createForumTopic(
      operator.telegram_user_id,
      topicName(ticket, settings.telegramWaitEmoji)
    );
    db.saveTelegramThread.run(
      ticket.id,
      operator.telegram_user_id,
      String(operator.telegram_user_id),
      topic.message_thread_id,
      null
    );
    const options = {
      message_thread_id: topic.message_thread_id,
      reply_markup: ticketKeyboard(ticket, 'open')
    };
    const intro = await sendRichOrText(
      operator.telegram_user_id,
      ticketRichMarkdown(ticket, 'assigned', { operatorName: operator.display_name }),
      options,
      ticketFallbackText(ticket, 'assigned', { operatorName: operator.display_name })
    );
    if (intro) {
      db.setTelegramThreadRoot.run(intro.message_id, ticket.id, operator.telegram_user_id);
      if (settings.telegramPinNewTicketMessage) {
        bot.pinChatMessage(operator.telegram_user_id, intro.message_id, {
          message_thread_id: topic.message_thread_id
        }).catch(() => {});
      }
    }
    const thread = db.getTelegramThreadForTicketOperator.get(ticket.id, operator.telegram_user_id);
    console.log(`[TG private] Created ${operator.telegram_user_id}:${topic.message_thread_id} for ${shortId(ticket)}`);
    return thread;
  })().finally(() => {
    observeLatency('topicCreateMs', startedAt);
    creatingThreads.delete(key);
  });
  creatingThreads.set(key, promise);
  return promise;
}

function topicName(ticket, emoji) {
  return formatTemplate(cfg().telegramTopicNameTemplate, {
    emoji,
    name: ticket.user_name || 'Клиент',
    shortId: shortId(ticket),
    date: new Date().toLocaleDateString('ru-RU')
  }).slice(0, 128);
}

async function setTopicStatus(thread, ticket, emoji) {
  if (!thread) return;
  const name = topicName(ticket, emoji);
  const key = topicKey(thread.chat_id, thread.thread_id);
  if (topicStatus.get(key) === name) return;
  await bot.editForumTopic(thread.chat_id, thread.thread_id, { name });
  topicStatus.set(key, name);
}

async function focusTicketTopic(ticket, operator) {
  if (!ticket || ticket.status !== 'open') throw new Error('Ticket is not open');
  if (String(ticket.assigned_operator_id || '') !== String(operator.telegram_user_id)) {
    const error = new Error('Тикет назначен другому оператору');
    error.alreadyAssigned = true;
    throw error;
  }
  const thread = db.getTelegramThreadForTicketOperator.get(
    ticket.id,
    operator.telegram_user_id
  );
  if (!thread) throw new Error('Private topic is unavailable');
  const key = topicKey(thread.chat_id, thread.thread_id);
  const previousMessageId = focusMarkers.get(key);
  if (previousMessageId) {
    await bot.deleteMessage(thread.chat_id, previousMessageId).catch(() => {});
  }
  const sent = await bot.sendMessage(
    thread.chat_id,
    '🔎 Тема поднята из панели оператора',
    {
      message_thread_id: thread.thread_id,
      disable_notification: true
    }
  );
  focusMarkers.set(key, sent.message_id);
  return thread;
}

async function handleCallbackQuery(query) {
  resetPollingErrors();
  if (!tgEnabled()) return;
  const userId = String(query.from?.id || '');
  if (query.message?.chat?.type !== 'private') {
    await bot.answerCallbackQuery(query.id, { text: 'Нет доступа', show_alert: true }).catch(() => {});
    return;
  }
  if (!isAuthorized(userId)) {
    const action = String(query.data || '');
    await bot.answerCallbackQuery(query.id).catch(() => {});
    if (!cfg().telegramCustomerEnabled) return;
    try {
      if (action === 'customer:close') return closeCustomerTicket({
        from: query.from,
        chat: query.message.chat,
        message_id: query.message.message_id
      });
      if (action === 'customer:new') {
        const existing = db.getOpenTicketByTelegramCustomer.get(userId);
        if (existing) {
          return ensureCustomerControlMessage(existing, { forceNew: true, repin: true });
        }
        const result = await ensureCustomerTicket({
          from: query.from,
          chat: query.message.chat
        }, { forceNew: true });
        return startCustomerTicketExperience(result.ticket, {
          replaceMessageId: query.message.message_id
        });
      }
    } catch (error) {
      console.error('[TG private] customer callback:', tgError(error));
      await bot.sendMessage(
        query.message.chat.id,
        '⚠️ Не удалось создать тикет. Попробуйте нажать кнопку ещё раз.'
      ).catch(() => {});
    }
    return;
  }
  const operator = registerOperator(query.from);
  const data = String(query.data || '');
  let callbackAnswered = false;
  const answer = async options => {
    if (callbackAnswered) return;
    callbackAnswered = true;
    await bot.answerCallbackQuery(query.id, options).catch(() => {});
  };
  try {
    if (data === 'dashboard:refresh' || data === 'dashboard:show' || data === 'queue:refresh') {
      await answer();
      await editPanel(query.message, dashboardModel(operator));
      return;
    }
    if (data === 'queue:list') {
      await answer();
      await editPanel(query.message, ticketListModel(operator, 'waiting', 0));
      return;
    }
    const listMatch = data.match(/^list:(waiting|mine|closed):(\d+)$/);
    if (listMatch) {
      await answer();
      await editPanel(
        query.message,
        ticketListModel(operator, listMatch[1], Number(listMatch[2]))
      );
      return;
    }
    const parts = data.split(':');
    const action = parts[0] || '';
    const ticketId = parts[1] || '';
    const sourcePage = Math.max(0, Number(parts[2]) || 0);
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket) {
      await bot.answerCallbackQuery(query.id, { text: 'Тикет не найден', show_alert: true });
      return;
    }
    if (action === 'claim') {
      await answer({ text: 'Создаю тему…' });
      const thread = await claimAndOpenTicket(ticket.id, userId);
      await editPanel(query.message, ticketListModel(operator, 'waiting', sourcePage));
      if (!thread) {
        await bot.sendMessage(query.message.chat.id, '⚠️ Не удалось создать тему тикета.');
      }
      return;
    }
    if (action === 'focus') {
      await answer();
      await focusTicketTopic(ticket, operator);
      return;
    }
    if (action === 'restore') {
      if (String(ticket.assigned_operator_id || '') !== userId) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Тикет назначен другому оператору',
          show_alert: true
        });
        return;
      }
      await answer({ text: 'Открываю тикет…' });
      if (ticket.status === 'closed') {
        await reopenTicketFromTelegram(ticket, operator);
      }
      await editPanel(query.message, ticketListModel(operator, 'closed', sourcePage));
      return;
    }
    if (action === 'take') {
      await answer({ text: 'Создаю тему…' });
      const thread = await claimAndOpenTicket(ticket.id, userId);
      if (!thread) {
        await bot.sendMessage(query.message.chat.id, '⚠️ Не удалось создать тему тикета.');
      }
      return;
    }
    if (!operatorCanControlTicket(ticket, userId, query)) {
      await bot.answerCallbackQuery(query.id, { text: 'Тикет назначен другому оператору', show_alert: true });
      return;
    }
    if (action === 'customercontrol') {
      if (ticket.source !== 'telegram') {
        await bot.answerCallbackQuery(query.id, {
          text: 'Этот клиент пишет через сайт',
          show_alert: true
        });
        return;
      }
      await answer({ text: 'Закрепляю кнопку у клиента…' });
      await ensureCustomerControlMessage(ticket, { forceNew: true, repin: true });
      return;
    }
    if (action === 'close') {
      if (ticket.status === 'closed') {
        await bot.answerCallbackQuery(query.id, { text: 'Тикет уже закрыт' });
      } else {
        await answer({ text: 'Закрываю тикет…' });
        await closeTicketFromTelegram(ticket);
      }
      return;
    }
    if (action === 'reopen') {
      if (ticket.status === 'open') {
        await bot.answerCallbackQuery(query.id, { text: 'Тикет уже открыт' });
      } else {
        await answer({ text: 'Открываю тикет…' });
        await reopenTicketFromTelegram(ticket, operator);
      }
      return;
    }
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    const message = error.alreadyAssigned ? error.message : 'Ошибка. Проверьте уведомления.';
    if (!callbackAnswered) {
      await answer({ text: message, show_alert: true });
    } else {
      await bot.sendMessage(query.message.chat.id, `⚠️ ${message}`).catch(() => {});
    }
    console.error('[TG private] callback:', tgError(error));
  }
}

function parseCommand(text) {
  const match = String(text || '').trim().toLowerCase().match(/^(\/\w+)(?:@\w+)?/);
  return match ? match[1] : null;
}

async function handleMessage(msg) {
  connected = true;
  resetPollingErrors();
  if (!tgEnabled() || msg.chat?.type !== 'private') return;
  if (await handleTelegramServiceMessage(msg)) return;
  if (msg.from?.is_bot) return;
  if (!isAuthorized(msg.from?.id)) {
    return handleCustomerMessage(msg);
  }
  const operator = registerOperator(msg.from);
  const command = parseCommand(msg.text || msg.caption);
  if (command === '/start') return handleStart(msg);
  if (command === '/admin') {
    const webAppUrl = adminWebAppUrl();
    return bot.sendMessage(msg.chat.id, 'Админка поддержки:', {
      reply_markup: webAppUrl
        ? { inline_keyboard: [[{ text: 'Открыть админку', web_app: { url: webAppUrl } }]] }
        : undefined
    });
  }
  if (command === '/queue') {
    return sendDashboard(operator);
  }
  if (command === '/waiting') return sendTicketList(operator, 'waiting');
  if (command === '/open') return sendTicketList(operator, 'mine');
  if (command === '/closed') return sendTicketList(operator, 'closed');
  const threadId = msg.message_thread_id;
  const thread = threadId
    ? db.getTelegramThreadByDestination.get(String(msg.chat.id), threadId)
    : null;
  if (!thread) {
    if (msg.reply_to_message) {
      const notification = db.getTelegramNotificationByDestination.get(
        String(msg.chat.id),
        msg.reply_to_message.message_id
      );
      if (notification) {
        await bot.sendMessage(msg.chat.id, 'Сначала нажмите «Взять тикет», затем отвечайте внутри созданной темы.');
        return;
      }
    }
    if (msg.text || msg.caption || msg.document || msg.photo || msg.video) {
      await bot.sendMessage(msg.chat.id, 'Выберите тикет в очереди или откройте его тему. Команда: /queue');
    }
    return;
  }

  const ticket = db.getTicketById.get(thread.ticket_id);
  if (!ticket) return;
  if (String(ticket.assigned_operator_id || '') !== String(operator.telegram_user_id)) {
    await bot.sendMessage(msg.chat.id, 'Тикет больше не назначен вам.', { message_thread_id: threadId });
    return;
  }
  if (command === '/close') {
    if (ticket.status === 'closed') {
      return bot.sendMessage(msg.chat.id, 'Тикет уже закрыт.', { message_thread_id: threadId });
    }
    return closeTicketFromTelegram(ticket);
  }
  if (command === '/reopen') {
    if (ticket.status === 'open') {
      return bot.sendMessage(msg.chat.id, 'Тикет уже открыт.', { message_thread_id: threadId });
    }
    return reopenTicketFromTelegram(ticket, operator);
  }
  if (ticket.status === 'closed') {
    await bot.sendMessage(msg.chat.id, 'Тикет закрыт. Используйте /reopen.', {
      message_thread_id: threadId,
      reply_markup: ticketKeyboard(ticket, 'closed')
    });
    return;
  }
  if (!cfg().telegramForwardOperatorMessages) return;
  await forwardOperatorMessage(msg, ticket, thread, operator);
}

async function forwardOperatorMessage(msg, ticket, thread, operator) {
  const incomingKey = `${msg.chat.id}:${msg.message_id}`;
  if (incomingMessages.has(incomingKey) ||
      db.getMessageByTelegramDestination.get(String(msg.chat.id), msg.message_id)) {
    deliveryStats.incomingDuplicates++;
    return;
  }
  incomingMessages.add(incomingKey);
  try {
    const rawText = msg.text || msg.caption || null;
    let type = 'text';
    let fileUrl = null;
    let fileName = null;
    let fileMime = null;
    if (msg.photo || msg.video || msg.document || msg.voice || msg.audio || msg.animation || msg.video_note) {
      const file = await downloadFile(msg);
      if (file) {
        fileUrl = file.url;
        fileName = file.name;
        fileMime = file.mime;
        type = file.type;
      } else {
        deliveryStats.mediaFailures++;
        await operationalAlert(
          `tg-media-${ticket.id}`,
          `Не удалось получить файл оператора (тикет ${shortId(ticket)})`,
          `Telegram message_id=${msg.message_id}`
        );
        await bot.sendMessage(
          thread.chat_id,
          '⚠️ Файл не доставлен клиенту. Отправьте его повторно или как документ.',
          { message_thread_id: thread.thread_id }
        );
      }
    }
    if (!rawText && !fileUrl) return;

    let replyToId = null;
    let replyMessage = null;
    if (msg.reply_to_message) {
      replyMessage = db.getMessageByTelegramDestination.get(
        String(msg.chat.id),
        msg.reply_to_message.message_id
      );
      if (replyMessage?.ticket_id === ticket.id) replyToId = replyMessage.id;
    }
    const id = uuidv4();
    db.saveMessage.run(
      id,
      ticket.id,
      'support',
      operator.display_name,
      rawText,
      type,
      fileUrl,
      fileName,
      fileMime,
      msg.message_id,
      replyToId
    );
    db.updateTelegramDelivery.run(String(msg.chat.id), msg.message_id, id);
    const message = {
      id,
      ticket_id: ticket.id,
      sender: 'support',
      sender_name: operator.display_name,
      content: rawText,
      message_type: type,
      file_url: fileUrl,
      file_name: fileName,
      file_mime: fileMime,
      created_at: new Date().toISOString(),
      reply_to_id: replyToId,
      reply_to_content: replyMessage?.content || null,
      reply_to_sender_name: replyMessage?.sender_name || null,
      reply_to_type: replyMessage?.message_type || null,
      reply_to_file_name: replyMessage?.file_name || null
    };
    db.markSupportRead.run(ticket.id);
    lifecycle.cancelOperatorWait?.(ticket.id);
    io?.to(`ticket:${ticket.id}`).emit('message', message);
    io?.to('admin').emit('admin_new_message', { ticketId: ticket.id, message });
    io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
    await setTopicStatus(thread, ticket, cfg().telegramOpenEmoji).catch(() => {});
    deliverCustomerReply(ticket, message).catch(error => {
      console.error('[TG private] customer delivery:', tgError(error));
    });
    push.send(ticket.id, rawText || fileName || 'Новое сообщение').catch(() => {});
  } finally {
    incomingMessages.delete(incomingKey);
  }
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
  const filePath = path.resolve(uploadsDir, relative);
  return filePath.startsWith(`${uploadsDir}${path.sep}`) ? filePath : null;
}

async function sendWithDocumentFallback(primary, chatId, filePath, options) {
  try {
    return await primary();
  } catch (error) {
    const message = tgError(error).toLowerCase();
    if (message.includes('wrong file identifier') ||
        message.includes('photo_invalid') ||
        message.includes('failed to get http url content') ||
        message.includes('bad request')) {
      return bot.sendDocument(chatId, filePath, options);
    }
    throw error;
  }
}

async function sendMessageToThread(ticket, message, thread) {
  const options = {
    message_thread_id: thread.thread_id,
    ...(message.sender === 'user'
      ? { reply_markup: ticketKeyboard(ticket, ticket.status === 'closed' ? 'closed' : 'open') }
      : {})
  };
  const filePath = publicUploadPath(message.file_url);
  const content = String(message.content || '').trim();
  if (message.message_type === 'text') {
    if (message.sender === 'user') {
      return sendRichOrText(
        thread.chat_id,
        `### 👤 ${markdownEscape(ticket.user_name || 'Клиент')}\n\n${markdownEscape(content)}`,
        options,
        `👤 ${ticket.user_name || 'Клиент'}\n\n${content}`
      );
    }
    return bot.sendMessage(
      thread.chat_id,
      `↩️ ${message.sender_name || cfg().supportName}\n\n${content}`.slice(0, 4000),
      options
    );
  }
  const captionPrefix = message.sender === 'user'
    ? `👤 ${ticket.user_name || 'Клиент'}`
    : `↩️ ${message.sender_name || cfg().supportName}`;
  const caption = `${captionPrefix}${content ? `\n\n${content}` : ''}`.slice(0, 1000);
  if (message.message_type === 'image' && filePath) {
    return sendWithDocumentFallback(
      () => bot.sendPhoto(thread.chat_id, filePath, { ...options, caption }),
      thread.chat_id,
      filePath,
      { ...options, caption }
    );
  }
  if (message.message_type === 'video' && filePath) {
    return sendWithDocumentFallback(
      () => bot.sendVideo(thread.chat_id, filePath, { ...options, caption }),
      thread.chat_id,
      filePath,
      { ...options, caption }
    );
  }
  if (message.message_type === 'audio' && filePath) {
    return sendWithDocumentFallback(
      () => bot.sendAudio(thread.chat_id, filePath, { ...options, caption }),
      thread.chat_id,
      filePath,
      { ...options, caption }
    );
  }
  if (filePath) return bot.sendDocument(thread.chat_id, filePath, { ...options, caption });
  throw new Error('Attachment file is unavailable');
}

async function sendMessageToCustomer(ticket, message) {
  const chatId = String(ticket.telegram_customer_chat_id || ticket.telegram_customer_id || '');
  if (!chatId) throw new Error('Telegram customer chat is unavailable');
  const filePath = publicUploadPath(message.file_url);
  const content = String(message.content || '').trim();
  const options = {};
  if (message.message_type === 'text') {
    return sendRichOrText(
      chatId,
      `### 👨‍💻 ${markdownEscape(message.sender_name || cfg().supportName)}\n\n${markdownEscape(content.slice(0, 3500))}`,
      options,
      `👨‍💻 ${message.sender_name || cfg().supportName}\n\n${content.slice(0, 3900)}`
    );
  }
  const caption = content.slice(0, 1000);
  if (message.message_type === 'image' && filePath) {
    return sendWithDocumentFallback(
      () => bot.sendPhoto(chatId, filePath, { ...options, caption }),
      chatId,
      filePath,
      { ...options, caption }
    );
  }
  if (message.message_type === 'video' && filePath) {
    return sendWithDocumentFallback(
      () => bot.sendVideo(chatId, filePath, { ...options, caption }),
      chatId,
      filePath,
      { ...options, caption }
    );
  }
  if (message.message_type === 'audio' && filePath) {
    return sendWithDocumentFallback(
      () => bot.sendAudio(chatId, filePath, { ...options, caption }),
      chatId,
      filePath,
      { ...options, caption }
    );
  }
  if (filePath) return bot.sendDocument(chatId, filePath, { ...options, caption });
  throw new Error('Attachment file is unavailable');
}

async function deliverCustomerReply(ticket, message) {
  const settings = cfg();
  const fresh = db.getTicketById.get(ticket?.id || message?.ticket_id);
  if (!tgEnabled() || !settings.telegramCustomerEnabled ||
      !settings.telegramCustomerDeliverReplies || fresh?.source !== 'telegram' ||
      fresh?.status !== 'open' || closingCustomerTickets.has(fresh.id) ||
      message?.sender !== 'support') {
    return null;
  }
  const saved = db.getMessageById.get(message.id) || message;
  if (saved.telegram_customer_message_id || customerDeliveryMessages.has(saved.id)) {
    return saved.telegram_customer_message_id || null;
  }
  customerDeliveryMessages.add(saved.id);
  try {
    const sent = await sendMessageToCustomer(fresh, saved);
    if (!sent?.message_id) throw new Error('Telegram did not confirm customer delivery');
    db.updateTelegramCustomerDelivery.run(sent.message_id, saved.id);
    const current = db.getTicketById.get(fresh.id);
    if (current?.status !== 'open' || closingCustomerTickets.has(fresh.id)) {
      await deleteTelegramMessage(
        String(fresh.telegram_customer_chat_id),
        sent.message_id
      );
      return null;
    }
    deliveryStats.customerDelivered++;
    deliveryStats.lastSuccessAt = new Date().toISOString();
    return sent.message_id;
  } catch (error) {
    const attempts = Number(saved.telegram_customer_attempts || 0) + 1;
    const delaySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)));
    db.markTelegramCustomerAttempt.run(
      tgError(error).slice(0, 1000),
      `+${delaySeconds} seconds`,
      saved.id
    );
    scheduleDeliveryQueue(delaySeconds * 1000 + 250);
    deliveryStats.customerFailed++;
    deliveryStats.lastError = tgError(error);
    if (attempts >= 3) {
      await operationalAlert(
        `tg-customer-delivery-${saved.id}`,
        `Ответ не доставлен Telegram-клиенту после ${attempts} попыток`,
        `Тикет ${shortId(fresh)}: ${tgError(error)}`
      );
    }
    throw error;
  } finally {
    customerDeliveryMessages.delete(saved.id);
  }
}

async function forwardMessage(ticket, message, options = {}) {
  const settings = cfg();
  if (!tgEnabled()) return null;
  if (message.sender === 'user' && !settings.telegramForwardUserMessages) return null;
  if (message.sender === 'support' && !settings.telegramForwardAdminMessages) return null;
  if (message.telegram_message_id || forwardingMessages.has(message.id)) {
    return message.telegram_message_id || null;
  }

  let fresh = db.getTicketById.get(ticket.id);
  if (!fresh || fresh.status === 'closed') return null;
  if (!fresh.assigned_operator_id) {
    const operators = await registeredAuthorizedOperators({ discover: true });
    if (operators.length === 1 && cfg().telegramAutoAssignSingleOperator) {
      await autoAssignTicket(fresh, operators[0], { replay: false, message });
      fresh = db.getTicketById.get(fresh.id);
      const deliveredDuringAssignment = db.getMessageById.get(message.id);
      if (deliveredDuringAssignment?.telegram_message_id) {
        return deliveredDuringAssignment.telegram_message_id;
      }
    } else {
      deliveryStats.unassigned++;
      if (message.sender === 'user') {
        for (const operator of operators) {
          await sendAssignmentNotification(fresh, operator, {
            forceNew: false,
            message
          });
        }
      }
      return null;
    }
  }

  const operator = db.getTelegramOperator.get(String(fresh.assigned_operator_id));
  if (!operator || !operator.active || !isAuthorized(operator.telegram_user_id)) {
    db.unassignTicket.run(fresh.id);
    return null;
  }
  let thread = db.getTelegramThreadForTicketOperator.get(fresh.id, operator.telegram_user_id);
  if (!thread) thread = await ensurePrivateThread(fresh, operator);
  if (!thread) return null;

  forwardingMessages.add(message.id);
  const deliveryStartedAt = Date.now();
  try {
    const sent = await sendMessageToThread(fresh, message, thread);
    if (!sent) throw new Error('Telegram did not confirm delivery');
    db.updateTelegramDelivery.run(String(thread.chat_id), sent.message_id, message.id);
    deliveryStats.delivered++;
    deliveryStats.lastSuccessAt = new Date().toISOString();
    if (message.sender === 'user') {
      setTopicStatus(thread, fresh, settings.telegramWaitEmoji).catch(() => {});
    }
    return sent.message_id;
  } catch (error) {
    if (isThreadNotFound(error)) {
      db.deleteTelegramThread.run(fresh.id, operator.telegram_user_id);
      topicStatus.delete(topicKey(thread.chat_id, thread.thread_id));
      await operationalAlert(
        `tg-thread-${fresh.id}`,
        `Приватная тема тикета ${shortId(fresh)} недоступна`,
        tgError(error)
      );
    }
    const attempts = Number(message.telegram_attempts || 0) + 1;
    const delaySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)));
    db.markTelegramAttempt.run(tgError(error).slice(0, 1000), `+${delaySeconds} seconds`, message.id);
    scheduleDeliveryQueue(delaySeconds * 1000 + 250);
    deliveryStats.failed++;
    deliveryStats.lastError = tgError(error);
    if (attempts >= 3) {
      await operationalAlert(
        `tg-delivery-${message.id}`,
        `Сообщение не доставлено оператору после ${attempts} попыток`,
        `Тикет ${shortId(fresh)}: ${tgError(error)}`
      );
    }
    throw error;
  } finally {
    observeLatency('deliveryMs', deliveryStartedAt);
    forwardingMessages.delete(message.id);
  }
}

async function processDeliveryQueue() {
  if (deliveryRunning || !tgEnabled()) return;
  deliveryRunning = true;
  try {
    const messages = db.getPendingPrivateTelegramMessages.all(20);
    for (const message of messages) {
      const ticket = db.getTicketById.get(message.ticket_id);
      if (!ticket) continue;
      if (Number(message.telegram_attempts || 0) > 0) deliveryStats.retried++;
      await forwardMessage(ticket, message, { fromQueue: true }).catch(() => {});
      await wait(250);
    }
    const customerReplies = db.getPendingTelegramCustomerReplies.all(20);
    for (const message of customerReplies) {
      const ticket = db.getTicketById.get(message.ticket_id);
      if (!ticket) continue;
      await deliverCustomerReply(ticket, message).catch(() => {});
      await wait(250);
    }
    if (messages.length === 20 || customerReplies.length === 20) scheduleDeliveryQueue(250);
  } catch (error) {
    deliveryStats.lastError = tgError(error);
    console.error('[TG private] delivery queue:', tgError(error));
  } finally {
    deliveryRunning = false;
  }
}

async function replayUnsentMessages(ticket, limit = 30) {
  const messages = db.getUnsentMessagesForTelegram.all(ticket.id, limit);
  for (const message of messages) {
    await forwardMessage(db.getTicketById.get(ticket.id), message, { fromQueue: true }).catch(() => {});
    await wait(250);
  }
  if (messages.length === limit) {
    const thread = db.getTelegramThreadForTicket.get(ticket.id);
    if (thread) {
      await bot.sendMessage(
        thread.chat_id,
        '⚠️ Более старая история доступна в Mini App.',
        { message_thread_id: thread.thread_id }
      ).catch(() => {});
    }
    scheduleDeliveryQueue(250);
  }
}

async function closeTicketFromTelegram(ticket) {
  const startedAt = Date.now();
  const settings = cfg();
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  db.closeTicket.run(ticket.id);
  lifecycle.cancelOperatorWait?.(ticket.id);
  const fresh = db.getTicketById.get(ticket.id);
  io?.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'support' });
  io?.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  if (thread) {
    await Promise.allSettled([
      setTopicStatus(thread, fresh, settings.telegramClosedEmoji),
      bot.sendMessage(thread.chat_id, settings.telegramClosedBySupportText, {
        message_thread_id: thread.thread_id,
        reply_markup: ticketKeyboard(fresh, 'closed')
      })
    ]);
    if (settings.telegramCloseTopicOnClose) {
      await bot.closeForumTopic(thread.chat_id, thread.thread_id).catch(() => {});
    }
  }
  if (fresh?.source === 'telegram' && fresh.telegram_customer_chat_id) {
    await showClosedCustomerLauncher(
      fresh,
      settings.telegramCustomerClosedBySupportText
    ).catch(() => {});
  }
  db.closeTelegramThreadsForTicket.run(ticket.id);
  const operator = fresh.assigned_operator_id
    ? db.getTelegramOperator.get(String(fresh.assigned_operator_id))
    : null;
  updateAssignmentNotifications(fresh, operator).catch(error => {
    console.warn('[TG private] close notification update:', tgError(error));
  });
  if (settings.telegramCleanupClosedTopics && settings.telegramCleanupClosedHours === 0) {
    scheduleCleanupOldTopics();
  }
  observeLatency('closeMs', startedAt);
}

async function reopenTicketFromTelegram(ticket, operatorOverride = null) {
  const startedAt = Date.now();
  const settings = cfg();
  if (ticket.source === 'telegram' && ticket.telegram_customer_id) {
    const existing = db.getOpenTicketByTelegramCustomer.get(String(ticket.telegram_customer_id));
    if (existing && existing.id !== ticket.id) {
      const error = new Error(`У клиента уже открыт тикет ${shortId(existing)}`);
      error.alreadyAssigned = true;
      throw error;
    }
  }
  db.reopenTicket.run(ticket.id);
  let fresh = db.getTicketById.get(ticket.id);
  let operator = operatorOverride;
  if (!operator && fresh.assigned_operator_id) {
    operator = db.getTelegramOperator.get(String(fresh.assigned_operator_id));
  }
  if (!operator || !operator.active) {
    db.unassignTicket.run(fresh.id);
    fresh = db.getTicketById.get(fresh.id);
    await reconcileUnassignedTickets();
    if (fresh.source === 'telegram' && fresh.telegram_customer_chat_id) {
      await ensureCustomerControlMessage(fresh, {
        forceNew: true,
        repin: true
      }).catch(() => {});
    }
    observeLatency('reopenMs', startedAt);
    return;
  }
  let thread = db.getTelegramThreadForTicketOperatorAny.get(fresh.id, operator.telegram_user_id);
  if (thread) {
    try {
      if (settings.telegramReopenTopicOnReopen) {
        await bot.reopenForumTopic(thread.chat_id, thread.thread_id);
      }
      db.reopenTelegramThread.run(fresh.id, operator.telegram_user_id);
      thread = db.getTelegramThreadForTicketOperator.get(fresh.id, operator.telegram_user_id);
    } catch (error) {
      if (!isThreadNotFound(error)) throw error;
      db.deleteTelegramThread.run(fresh.id, operator.telegram_user_id);
      thread = null;
    }
  }
  if (!thread) thread = await ensurePrivateThread(fresh, operator);
  await Promise.allSettled([
    setTopicStatus(thread, fresh, settings.telegramWaitEmoji),
    bot.sendMessage(thread.chat_id, settings.telegramReopenedText, {
      message_thread_id: thread.thread_id,
      reply_markup: ticketKeyboard(fresh, 'open')
    }),
    updateAssignmentNotifications(fresh, operator)
  ]);
  io?.to(`ticket:${fresh.id}`).emit('ticket_reopened');
  io?.to('admin').emit('admin_ticket_status', { ticketId: fresh.id, status: 'open' });
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  if (fresh.source === 'telegram' && fresh.telegram_customer_chat_id) {
    await ensureCustomerControlMessage(fresh, {
      forceNew: true,
      repin: true
    }).catch(() => {});
  }
  observeLatency('reopenMs', startedAt);
}

async function notifyTicketClosed(ticket, {
  customerReason = cfg().telegramCustomerClosedBySupportText,
  extraMessageIds = []
} = {}) {
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  const fresh = db.getTicketById.get(ticket.id) || ticket;
  if (fresh.source === 'telegram' && fresh.telegram_customer_chat_id) {
    await showClosedCustomerLauncher(fresh, customerReason, {
      extraMessageIds
    }).catch(() => {});
  }
  if (thread) {
    await setTopicStatus(thread, fresh, cfg().telegramClosedEmoji).catch(() => {});
    await bot.sendMessage(thread.chat_id, cfg().telegramClosedByUserText, {
      message_thread_id: thread.thread_id,
      reply_markup: ticketKeyboard(fresh, 'closed')
    }).catch(() => {});
    if (cfg().telegramCloseTopicOnClose) {
      await bot.closeForumTopic(thread.chat_id, thread.thread_id).catch(() => {});
    }
  }
  db.closeTelegramThreadsForTicket.run(ticket.id);
  const operator = fresh.assigned_operator_id
    ? db.getTelegramOperator.get(String(fresh.assigned_operator_id))
    : null;
  await updateAssignmentNotifications(fresh, operator);
}

async function notifyTicketReopened(ticket) {
  const fresh = db.getTicketById.get(ticket.id) || ticket;
  const operator = fresh.assigned_operator_id
    ? db.getTelegramOperator.get(String(fresh.assigned_operator_id))
    : null;
  return reopenTicketFromTelegram(fresh, operator);
}

async function autoCloseTicket(ticket, extra = {}) {
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  const fresh = db.getTicketById.get(ticket.id) || ticket;
  lifecycle.cancelOperatorWait?.(ticket.id);
  if (fresh.source === 'telegram' && fresh.telegram_customer_chat_id) {
    const reason = formatTemplate(
      cfg().telegramCustomerClosedBySystemText,
      extra
    );
    await showClosedCustomerLauncher(fresh, reason).catch(() => {});
  }
  if (thread) {
    await setTopicStatus(thread, fresh, cfg().telegramClosedEmoji).catch(() => {});
    await bot.sendMessage(
      thread.chat_id,
      formatTemplate(cfg().telegramAutoCloseText, extra),
      {
        message_thread_id: thread.thread_id,
        reply_markup: ticketKeyboard(fresh, 'closed')
      }
    ).catch(() => {});
    if (cfg().telegramCloseTopicOnClose) {
      await bot.closeForumTopic(thread.chat_id, thread.thread_id).catch(() => {});
    }
  }
  db.closeTelegramThreadsForTicket.run(ticket.id);
  const operator = fresh.assigned_operator_id
    ? db.getTelegramOperator.get(String(fresh.assigned_operator_id))
    : null;
  await updateAssignmentNotifications(fresh, operator);
}

async function warnInactivity(ticket, extra = {}) {
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  if (thread) {
    await bot.sendMessage(
      thread.chat_id,
      formatTemplate(cfg().telegramWarnInactivityText, extra),
      { message_thread_id: thread.thread_id }
    ).catch(() => {});
  }
  if (ticket.source === 'telegram' && ticket.telegram_customer_chat_id) {
    const text = formatTemplate(cfg().inactivityWarningText, extra);
    await sendCustomerRichNotice(
      ticket,
      `## ⚠️ Тикет скоро закроется\n\n${text}`,
      `⚠️ Тикет скоро закроется\n\n${text}`
    ).catch(() => {});
  }
}

async function sendTyping(ticket) {
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  if (!thread) return;
  await bot.sendChatAction(thread.chat_id, 'typing', {
    message_thread_id: thread.thread_id
  }).catch(() => {});
}

async function sendCustomerTyping(ticket) {
  if (!tgEnabled() || ticket?.source !== 'telegram' || !ticket.telegram_customer_chat_id) return;
  await bot.sendChatAction(ticket.telegram_customer_chat_id, 'typing').catch(() => {});
}

async function checkTopicAlive(ticket) {
  if (!tgEnabled()) return true;
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  if (!thread) return true;
  try {
    await bot.sendChatAction(thread.chat_id, 'typing', {
      message_thread_id: thread.thread_id
    });
    return true;
  } catch (error) {
    if (isThreadNotFound(error)) {
      db.deleteTelegramThread.run(ticket.id, thread.operator_id);
      return true;
    }
    return true;
  }
}

function scheduleCleanupOldTopics(delayMs = 10000) {
  clearTimeout(cleanupTimer);
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    cleanupOldTopics().catch(() => {});
  }, delayMs);
}

async function cleanupOldTopics() {
  const settings = cfg();
  if (!tgEnabled() || !settings.telegramCleanupClosedTopics) return;
  const cutoff = new Date(
    Date.now() - settings.telegramCleanupClosedHours * 60 * 60 * 1000
  ).toISOString().replace('T', ' ').slice(0, 19);
  const threads = db.getClosedTelegramThreadsBefore.all(cutoff);
  for (const thread of threads) {
    try {
      await bot.deleteForumTopic(thread.chat_id, thread.thread_id);
    } catch (error) {
      if (!isThreadNotFound(error)) {
        console.error(`[TG private] cleanup ${shortId(thread)}:`, tgError(error));
        continue;
      }
    }
    const notifications = db.getTelegramNotificationsForTicket.all(thread.ticket_id);
    for (const notification of notifications) {
      await bot.deleteMessage(notification.chat_id, notification.message_id).catch(() => {});
    }
    db.deleteTelegramNotificationsForTicket.run(thread.ticket_id);
    db.deleteTelegramThread.run(thread.ticket_id, thread.operator_id);
    topicStatus.delete(topicKey(thread.chat_id, thread.thread_id));
    focusMarkers.delete(topicKey(thread.chat_id, thread.thread_id));
    await wait(350);
  }
}

async function downloadFile(msg) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let fileId;
      let fileName;
      let fileMime;
      let type;
      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        fileId = photo.file_id;
        fileName = `photo_${Date.now()}.jpg`;
        fileMime = 'image/jpeg';
        type = 'image';
      } else if (msg.video) {
        fileId = msg.video.file_id;
        fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
        fileMime = msg.video.mime_type || 'video/mp4';
        type = 'video';
      } else if (msg.document) {
        fileId = msg.document.file_id;
        fileName = msg.document.file_name || `file_${Date.now()}`;
        const normalized = normalizeIncomingDocument(fileName, msg.document.mime_type);
        fileMime = normalized.mime;
        type = normalized.type;
      } else if (msg.voice) {
        fileId = msg.voice.file_id;
        fileName = `voice_${Date.now()}.ogg`;
        fileMime = msg.voice.mime_type || 'audio/ogg';
        type = 'audio';
      } else if (msg.audio) {
        fileId = msg.audio.file_id;
        fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
        fileMime = msg.audio.mime_type || 'audio/mpeg';
        type = 'audio';
      } else if (msg.animation) {
        fileId = msg.animation.file_id;
        fileName = msg.animation.file_name || `animation_${Date.now()}.mp4`;
        fileMime = msg.animation.mime_type || 'video/mp4';
        type = 'video';
      } else if (msg.video_note) {
        fileId = msg.video_note.file_id;
        fileName = `video_note_${Date.now()}.mp4`;
        fileMime = 'video/mp4';
        type = 'video';
      }
      if (!fileId) return null;
      const link = await bot.getFileLink(fileId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120000);
      let response;
      try {
        response = await fetch(link, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
      const maxBytes = cfg().uploadMaxMb * 1024 * 1024;
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > maxBytes) throw new Error('File too large');
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > maxBytes) throw new Error('File too large');
      const directory = process.env.UPLOADS_DIR || path.join(__dirname, '../public/uploads');
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
      const cleanName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160) || 'file';
      const safeName = `tg_${uuidv4()}_${cleanName}`;
      await fsp.writeFile(path.join(directory, safeName), buffer, { flag: 'wx' });
      return {
        url: `/uploads/${safeName}`,
        name: String(fileName).slice(0, 255),
        mime: fileMime,
        type
      };
    } catch (error) {
      lastError = error;
      console.error(`[TG private] download attempt ${attempt}:`, tgError(error));
      if (tgError(error).startsWith('Unsupported Telegram file type') ||
          tgError(error) === 'File too large') {
        break;
      }
      if (attempt < 3) await wait(attempt * 1000);
    }
  }
  deliveryStats.lastError = tgError(lastError);
  return null;
}

function reactionLabel(reaction) {
  if (!reaction) return '';
  if (reaction.type === 'emoji') return reaction.emoji || '';
  if (reaction.type === 'custom_emoji') return '💠';
  if (reaction.type === 'paid') return '⭐';
  return '';
}

async function handleMessageReaction(update) {
  if (!tgEnabled() || update.chat?.type !== 'private' || !isAuthorized(update.user?.id)) return;
  const message = db.getMessageByTelegramDestination.get(
    String(update.chat.id),
    update.message_id
  );
  if (!message) return;
  const reactions = (update.new_reaction || []).map(reactionLabel).filter(Boolean);
  db.updateMessageReactions.run(JSON.stringify(reactions), message.id);
  io?.to(`ticket:${message.ticket_id}`).emit('message_reactions', {
    messageId: message.id,
    reactions
  });
  io?.to('admin').emit('admin_message_reactions', {
    ticketId: message.ticket_id,
    messageId: message.id,
    reactions
  });
}

async function handleMessageReactionCount(update) {
  if (!tgEnabled() || update.chat?.type !== 'private') return;
  const message = db.getMessageByTelegramDestination.get(
    String(update.chat.id),
    update.message_id
  );
  if (!message) return;
  const reactions = (update.reactions || []).map(item => {
    const label = reactionLabel(item.type);
    return label && item.total_count > 1 ? `${label} ${item.total_count}` : label;
  }).filter(Boolean);
  db.updateMessageReactions.run(JSON.stringify(reactions), message.id);
  io?.to(`ticket:${message.ticket_id}`).emit('message_reactions', {
    messageId: message.id,
    reactions
  });
}

function status() {
  let registeredOperators = 0;
  let unassignedTickets = 0;
  let assignedOpenTickets = 0;
  let pendingMessages = 0;
  let oldestPendingSeconds = null;
  let pendingCustomerReplies = 0;
  let oldestCustomerReplySeconds = null;
  let openTelegramCustomerTickets = 0;
  try {
    registeredOperators = db.getActiveTelegramOperators.all().length;
    unassignedTickets = db.db.prepare(
      `SELECT COUNT(*) AS count FROM tickets WHERE status='open' AND assigned_operator_id IS NULL`
    ).get().count;
    assignedOpenTickets = db.db.prepare(
      `SELECT COUNT(*) AS count FROM tickets WHERE status='open' AND assigned_operator_id IS NOT NULL`
    ).get().count;
    openTelegramCustomerTickets = db.db.prepare(
      `SELECT COUNT(*) AS count FROM tickets WHERE status='open' AND source='telegram'`
    ).get().count;
    const pending = db.db.prepare(`
      SELECT COUNT(*) AS count, MIN(m.created_at) AS oldest
      FROM messages m
      JOIN tickets t ON t.id = m.ticket_id
      WHERE t.status = 'open'
        AND t.assigned_operator_id IS NOT NULL
        AND m.sender != 'system'
        AND COALESCE(m.is_auto, 0) = 0
        AND m.telegram_message_id IS NULL
    `).get();
    pendingMessages = Number(pending?.count || 0);
    if (pending?.oldest) {
      oldestPendingSeconds = Math.max(
        0,
        Math.round((Date.now() - new Date(`${pending.oldest}Z`).getTime()) / 1000)
      );
    }
    const pendingCustomers = db.db.prepare(`
      SELECT COUNT(*) AS count, MIN(m.created_at) AS oldest
      FROM messages m
      JOIN tickets t ON t.id = m.ticket_id
      WHERE m.sender = 'support'
        AND t.source = 'telegram'
        AND m.telegram_customer_message_id IS NULL
    `).get();
    pendingCustomerReplies = Number(pendingCustomers?.count || 0);
    if (pendingCustomers?.oldest) {
      oldestCustomerReplySeconds = Math.max(
        0,
        Math.round((Date.now() - new Date(`${pendingCustomers.oldest}Z`).getTime()) / 1000)
      );
    }
  } catch {}
  return {
    mode: 'private',
    configured: !!TOKEN,
    operatorAccessConfigured: ADMIN_IDS.size > 0,
    enabled: !!cfg().telegramEnabled,
    botStarted: !!bot,
    connected,
    botUsername: botUsername || null,
    threadedModeEnabled,
    richMessagesAvailable,
    polling: {
      ...(pollingLease?.status() || { owner: false, pausedUntil: null }),
      ...pollingStats
    },
    allowedOperators: ADMIN_IDS.size,
    registeredOperators,
    unassignedTickets,
    assignedOpenTickets,
    customerChannelEnabled: !!cfg().telegramCustomerEnabled,
    openTelegramCustomerTickets,
    miniAppConfigured: !!adminWebAppUrl(),
    pollingIntervalMs: POLLING_INTERVAL_MS,
    pendingThreadCreates: creatingThreads.size,
    latency: latencySummary(),
    delivery: {
      ...deliveryStats,
      inFlight: forwardingMessages.size,
      pendingMessages,
      oldestPendingSeconds,
      pendingCustomerReplies,
      oldestCustomerReplySeconds,
      scheduledInMs: deliveryWakeAt ? Math.max(0, deliveryWakeAt - Date.now()) : null
    },
    reminders: {
      ...reminderStats,
      enabled: !!cfg().telegramUnansweredReminderEnabled,
      firstAfterMinutes: cfg().telegramUnansweredReminderMinutes,
      repeatEveryMinutes: cfg().telegramUnansweredRepeatMinutes,
      inFlight: reminderRunning
    }
  };
}

async function shutdown() {
  clearTimeout(cleanupTimer);
  clearInterval(deliveryTimer);
  clearInterval(reminderTimer);
  clearTimeout(deliveryWakeTimer);
  cleanupTimer = null;
  deliveryTimer = null;
  reminderTimer = null;
  deliveryWakeTimer = null;
  await pollingLease?.stop();
  pollingLease = null;
  await stopBot('shutdown');
}

async function createTopic(ticketId) {
  if (!tgEnabled()) return null;
  const readyDeadline = Date.now() + 8000;
  while (bot && !connected && Date.now() < readyDeadline) await wait(200);

  let lastError = null;
  for (let attempt = 1; attempt <= TOPIC_CREATE_ATTEMPTS; attempt++) {
    const ticket = db.getTicketById.get(ticketId);
    if (!ticket || ticket.status !== 'open') return null;
    try {
      const operators = await registeredAuthorizedOperators({ discover: true });
      if (!operators.length) throw new Error('No registered Telegram operator');
      if (operators.length === 1 && cfg().telegramAutoAssignSingleOperator) {
        const thread = await autoAssignTicket(ticket, operators[0], {
          suppressFailureReport: true
        });
        return thread?.thread_id || null;
      }
      for (const operator of operators) {
        await sendAssignmentNotification(ticket, operator, { forceNew: false });
      }
      return null;
    } catch (error) {
      lastError = error;
      const current = db.getTicketById.get(ticketId);
      if (!current || current.status !== 'open') return null;
      console.warn(
        `[TG private] create topic ${shortId(ticket)} attempt ${attempt}/${TOPIC_CREATE_ATTEMPTS}:`,
        tgError(error)
      );
      if (attempt < TOPIC_CREATE_ATTEMPTS) {
        await wait(TOPIC_CREATE_RETRY_MS * attempt);
      }
    }
  }

  const ticket = db.getTicketById.get(ticketId);
  const operators = await registeredAuthorizedOperators({ discover: true });
  if (ticket && operators.length === 1) {
    await reportAssignmentFailure(ticket, operators[0], lastError);
  } else if (ticket) {
    await operationalAlert(
      'telegram-no-operators',
      `Тикет ${shortId(ticket)} ждёт регистрации оператора`,
      'Откройте личный чат с ботом и выполните /start.'
    );
    for (const telegramUserId of ADMIN_IDS) {
      await bot.sendMessage(
        telegramUserId,
        `🆕 Новый тикет ${shortId(ticket)} ждёт оператора.\nОтправьте /start, затем откройте /queue.`,
        { disable_notification: false }
      ).catch(() => {});
    }
  }
  return null;
}

module.exports = {
  init,
  createTopic,
  forwardMessage,
  deliverCustomerReply,
  sendCustomerControl,
  notifyTicketClosed,
  notifyTicketReopened,
  autoCloseTicket,
  sendTyping,
  sendCustomerTyping,
  warnInactivity,
  checkTopicAlive,
  status,
  processUnansweredReminders,
  notifyOperationalIssue: operationalAlert,
  shutdown
};
