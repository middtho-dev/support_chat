const { TelegramBot } = require('node-telegram-bot-api');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const db = require('./database');
const push = require('./push');
const { v4: uuidv4 } = require('uuid');
const { loadSettings, formatTemplate } = require('./settings');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = new Set(
  String(process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);
const DISPLAY_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const TICKET_LIST_PAGE_SIZE = 8;
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
let reconnectTimer = null;
let cleanupTimer = null;
let deliveryTimer = null;
let deliveryRunning = false;
let connected = false;
let threadedModeEnabled = false;
let richMessagesAvailable = true;
let botUsername = '';

const creatingThreads = new Map();
const forwardingMessages = new Set();
const incomingMessages = new Set();
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
  lastError: null,
  lastSuccessAt: null
};

function cfg() {
  return loadSettings();
}

function tgEnabled() {
  return cfg().telegramEnabled && !!bot && !!TOKEN && ADMIN_IDS.size > 0;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shortId(ticket) {
  return String(ticket?.id || '').slice(0, 8);
}

function tgError(error) {
  return String(error?.response?.body?.description || error?.message || error || 'unknown error');
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
  if (webAppUrl) rows.push([{ text: '📋 Открыть карточку', web_app: { url: webAppUrl } }]);
  return { inline_keyboard: rows };
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
  if (view === 'waiting') return '🔔 Новые обращения';
  if (view === 'closed') return '✅ Закрытые обращения';
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

function lastTicketMessage(ticketId) {
  const messages = db.getMessagesRecent.all(ticketId, 1);
  return messages[0] || null;
}

function messagePreview(message) {
  if (!message) return 'Клиент открыл новое обращение.';
  const text = String(message.content || '').trim();
  if (text) return text.slice(0, 1200);
  if (message.message_type === 'image') return `🖼 Изображение${message.file_name ? `: ${message.file_name}` : ''}`;
  if (message.message_type === 'video') return `🎬 Видео${message.file_name ? `: ${message.file_name}` : ''}`;
  if (message.message_type === 'audio') return `🎤 Аудио${message.file_name ? `: ${message.file_name}` : ''}`;
  return `📎 Файл${message.file_name ? `: ${message.file_name}` : ''}`;
}

function ticketRichMarkdown(ticket, state = 'unassigned', extra = {}) {
  const current = db.getTicketById.get(ticket.id) || ticket;
  const lastMessage = extra.message || lastTicketMessage(current.id);
  const stateLabel = state === 'closed'
    ? '✅ Закрыт'
    : state === 'assigned'
      ? `🔵 В работе${extra.operatorName ? ` · ${markdownEscape(extra.operatorName)}` : ''}`
      : '🔔 Ждёт оператора';
  const created = current.created_at
    ? new Date(current.created_at).toLocaleString('ru-RU')
    : new Date().toLocaleString('ru-RU');

  return [
    `## ${stateLabel}`,
    `**${markdownEscape(current.user_name || 'Клиент')}** · \`${markdownEscape(shortId(current))}\``,
    '',
    `> ${markdownEscape(messagePreview(lastMessage)).replace(/\n/g, '\n> ')}`,
    '',
    `<details><summary>Детали тикета</summary>`,
    '',
    `- Создан: ${markdownEscape(created)}`,
    `- Статус: ${markdownEscape(current.status || 'open')}`,
    `- ID: \`${markdownEscape(current.id)}\``,
    '',
    `</details>`
  ].join('\n');
}

function ticketFallbackText(ticket, state = 'unassigned', extra = {}) {
  const current = db.getTicketById.get(ticket.id) || ticket;
  const lastMessage = extra.message || lastTicketMessage(current.id);
  const status = state === 'closed'
    ? '✅ Закрыт'
    : state === 'assigned'
      ? `🔵 В работе${extra.operatorName ? ` · ${extra.operatorName}` : ''}`
      : '🔔 Ждёт оператора';
  return [
    status,
    `${current.user_name || 'Клиент'} · ${shortId(current)}`,
    '',
    messagePreview(lastMessage),
    '',
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
  const now = Date.now();
  if (now - (alertTimes.get(key) || 0) < 15 * 60 * 1000) return;
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

function init(socketIo) {
  io = socketIo;
  if (!TOKEN) {
    console.warn('[TG private] TELEGRAM_BOT_TOKEN not set — disabled');
    return null;
  }
  if (!ADMIN_IDS.size) {
    console.warn('[TG private] TELEGRAM_ADMIN_IDS not set — disabled');
    return null;
  }
  startBot();
  deliveryTimer = setInterval(processDeliveryQueue, 15 * 1000);
  setTimeout(processDeliveryQueue, 5000);
  setInterval(reconcileUnassignedTickets, 60 * 1000);
  setTimeout(reconcileUnassignedTickets, 10000);
  setInterval(cleanupOldTopics, 60 * 60 * 1000);
  setTimeout(cleanupOldTopics, 15000);
  return bot;
}

function startBot() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  console.log('[TG private] Starting...');
  try {
    bot = new TelegramBot(TOKEN, {
      polling: {
        interval: 2000,
        autoStart: false,
        params: {
          timeout: 30,
          allowed_updates: ['message', 'callback_query', 'message_reaction', 'message_reaction_count']
        }
      }
    });
    bot.on('polling_error', error => {
      connected = false;
      console.error('[TG private] Polling:', tgError(error));
      operationalAlert('telegram-polling', 'Потеряно соединение с Telegram', tgError(error)).catch(() => {});
      scheduleReconnect();
    });
    bot.on('error', error => {
      console.error('[TG private] Error:', tgError(error));
      scheduleReconnect();
    });
    bot.on('message', handleMessage);
    bot.on('callback_query', handleCallbackQuery);
    bot.on('message_reaction', handleMessageReaction);
    bot.on('message_reaction_count', handleMessageReactionCount);
    bot.startPolling().catch(error => {
      connected = false;
      console.error('[TG private] startPolling:', tgError(error));
      scheduleReconnect();
    });
    configureBot().catch(error => {
      console.error('[TG private] configuration:', tgError(error));
      scheduleReconnect();
    });
  } catch (error) {
    console.error('[TG private] Failed to start:', tgError(error));
    scheduleReconnect();
  }
}

async function configureBot() {
  const me = await bot.getMe();
  connected = true;
  botUsername = me.username || '';
  threadedModeEnabled = !!me.has_topics_enabled;
  await bot.setMyCommands([
    { command: 'start', description: 'Запустить операторскую консоль' },
    { command: 'queue', description: 'Открыть панель оператора' },
    { command: 'waiting', description: 'Новые обращения' },
    { command: 'open', description: 'Мои открытые тикеты' },
    { command: 'closed', description: 'Мои закрытые тикеты' },
    { command: 'admin', description: 'Открыть админку' },
    { command: 'close', description: 'Закрыть текущий тикет' },
    { command: 'reopen', description: 'Переоткрыть текущий тикет' }
  ]).catch(() => {});
  const webAppUrl = adminWebAppUrl();
  if (webAppUrl) {
    await bot.setChatMenuButton({
      menu_button: { type: 'web_app', text: 'Админка', web_app: { url: webAppUrl } }
    }).catch(() => {});
  }
  console.log(`[TG private] Connected as @${botUsername || 'bot'}; threaded=${threadedModeEnabled}`);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const previous = bot;
    bot = null;
    if (previous) {
      previous.stopPolling().catch(() => {}).finally(startBot);
    } else {
      startBot();
    }
  }, 5000);
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

async function reconcileOperator(operator) {
  const tickets = db.getOpenUnassignedTickets.all(50);
  if (!cfg().telegramAutoAssignSingleOperator || ADMIN_IDS.size !== 1) return;
  for (const ticket of tickets) {
    await claimAndOpenTicket(ticket.id, operator.telegram_user_id).catch(() => {});
    await wait(150);
  }
}

async function reconcileUnassignedTickets() {
  if (!tgEnabled()) return;
  const operators = db.getActiveTelegramOperators.all()
    .filter(operator => isAuthorized(operator.telegram_user_id));
  if (!operators.length) {
    const waiting = db.getOpenUnassignedTickets.all(1);
    if (waiting.length) {
      await operationalAlert(
        'telegram-no-operators',
        'Есть обращения, но ни один Telegram-оператор не зарегистрирован',
        'Каждый оператор из TELEGRAM_ADMIN_IDS должен открыть личный чат с ботом и выполнить /start.'
      );
    }
    return;
  }
  const tickets = db.getOpenUnassignedTickets.all(50);
  for (const ticket of tickets) {
    if (cfg().telegramAutoAssignSingleOperator && ADMIN_IDS.size === 1) {
      await claimAndOpenTicket(ticket.id, operators[0].telegram_user_id).catch(() => {});
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
    { reply_markup: ticketKeyboard(fresh, 'unassigned') },
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
  for (const notification of notifications) {
    const belongsToAssignee =
      notification.operator_id === String(assignedOperator?.telegram_user_id || '');
    const keyboard = belongsToAssignee
      ? ticketKeyboard(ticket, state === 'closed' ? 'closed' : 'open')
      : { inline_keyboard: [] };
    await editRichOrDisable(
      notification.chat_id,
      notification.message_id,
      ticketRichMarkdown(ticket, state, { operatorName: operatorLabel }),
      keyboard,
      ticketFallbackText(ticket, state, { operatorName: operatorLabel })
    );
  }
  db.updateTelegramNotificationState.run(state, ticket.id);
}

async function claimAndOpenTicket(ticketId, operatorId) {
  const operator = db.getTelegramOperator.get(String(operatorId));
  if (!operator || !operator.active || !isAuthorized(operator.telegram_user_id)) {
    throw new Error('Operator is not registered');
  }
  const before = db.getTicketById.get(ticketId);
  if (!before || before.status !== 'open') throw new Error('Ticket is not open');
  if (!before.assigned_operator_id) {
    db.assignTicketIfUnassigned.run(operator.telegram_user_id, ticketId);
  }
  const ticket = db.getTicketById.get(ticketId);
  if (String(ticket.assigned_operator_id || '') !== String(operator.telegram_user_id)) {
    const owner = db.getTelegramOperator.get(String(ticket.assigned_operator_id || ''));
    const error = new Error(`Тикет уже взял ${owner?.display_name || 'другой оператор'}`);
    error.alreadyAssigned = true;
    throw error;
  }
  const thread = await ensurePrivateThread(ticket, operator);
  await updateAssignmentNotifications(ticket, operator);
  if (thread) await replayUnsentMessages(ticket);
  io?.to('admin').emit('admin_ticket_updated', db.getTicketById.get(ticket.id));
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  return thread;
}

async function ensurePrivateThread(ticket, operator) {
  const existing = db.getTelegramThreadForTicketOperator.get(ticket.id, operator.telegram_user_id);
  if (existing) return existing;
  const key = `${ticket.id}:${operator.telegram_user_id}`;
  if (creatingThreads.has(key)) return creatingThreads.get(key);
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
        await bot.pinChatMessage(operator.telegram_user_id, intro.message_id, {
          message_thread_id: topic.message_thread_id
        }).catch(() => {});
      }
    }
    const thread = db.getTelegramThreadForTicketOperator.get(ticket.id, operator.telegram_user_id);
    console.log(`[TG private] Created ${operator.telegram_user_id}:${topic.message_thread_id} for ${shortId(ticket)}`);
    return thread;
  })().finally(() => creatingThreads.delete(key));
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
  if (!tgEnabled()) return;
  const userId = String(query.from?.id || '');
  if (!isAuthorized(userId) || query.message?.chat?.type !== 'private') {
    await bot.answerCallbackQuery(query.id, { text: 'Нет доступа', show_alert: true }).catch(() => {});
    return;
  }
  const operator = registerOperator(query.from);
  const data = String(query.data || '');
  try {
    if (data === 'dashboard:refresh' || data === 'dashboard:show' || data === 'queue:refresh') {
      await editPanel(query.message, dashboardModel(operator));
      await bot.answerCallbackQuery(query.id, {
        text: data === 'dashboard:refresh' || data === 'queue:refresh'
          ? 'Данные обновлены'
          : 'Панель оператора'
      });
      return;
    }
    if (data === 'queue:list') {
      await editPanel(query.message, ticketListModel(operator, 'waiting', 0));
      await bot.answerCallbackQuery(query.id, { text: 'Очередь открыта' });
      return;
    }
    const listMatch = data.match(/^list:(waiting|mine|closed):(\d+)$/);
    if (listMatch) {
      await editPanel(
        query.message,
        ticketListModel(operator, listMatch[1], Number(listMatch[2]))
      );
      await bot.answerCallbackQuery(query.id);
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
      const thread = await claimAndOpenTicket(ticket.id, userId);
      await editPanel(query.message, ticketListModel(operator, 'waiting', sourcePage));
      await bot.answerCallbackQuery(query.id, {
        text: thread ? 'Тикет взят — тема создана' : 'Не удалось создать тему',
        show_alert: !thread
      });
      return;
    }
    if (action === 'focus') {
      await focusTicketTopic(ticket, operator);
      await bot.answerCallbackQuery(query.id, {
        text: 'Тема поднята наверх списка'
      });
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
      if (ticket.status === 'closed') {
        await reopenTicketFromTelegram(ticket, operator);
      }
      await editPanel(query.message, ticketListModel(operator, 'closed', sourcePage));
      await bot.answerCallbackQuery(query.id, { text: 'Тикет переоткрыт' });
      return;
    }
    if (action === 'take') {
      const thread = await claimAndOpenTicket(ticket.id, userId);
      await bot.answerCallbackQuery(query.id, {
        text: thread ? 'Тикет назначен вам' : 'Не удалось создать тему',
        show_alert: !thread
      });
      return;
    }
    if (String(ticket.assigned_operator_id || '') !== userId) {
      await bot.answerCallbackQuery(query.id, { text: 'Тикет назначен другому оператору', show_alert: true });
      return;
    }
    if (action === 'close') {
      if (ticket.status === 'closed') {
        await bot.answerCallbackQuery(query.id, { text: 'Тикет уже закрыт' });
      } else {
        await closeTicketFromTelegram(ticket);
        await bot.answerCallbackQuery(query.id, { text: 'Тикет закрыт' });
      }
      return;
    }
    if (action === 'reopen') {
      if (ticket.status === 'open') {
        await bot.answerCallbackQuery(query.id, { text: 'Тикет уже открыт' });
      } else {
        await reopenTicketFromTelegram(ticket, operator);
        await bot.answerCallbackQuery(query.id, { text: 'Тикет переоткрыт' });
      }
      return;
    }
    await bot.answerCallbackQuery(query.id);
  } catch (error) {
    await bot.answerCallbackQuery(query.id, {
      text: error.alreadyAssigned ? error.message : 'Ошибка. Проверьте уведомления.',
      show_alert: true
    }).catch(() => {});
    console.error('[TG private] callback:', tgError(error));
  }
}

function parseCommand(text) {
  const match = String(text || '').trim().toLowerCase().match(/^(\/\w+)(?:@\w+)?/);
  return match ? match[1] : null;
}

async function handleMessage(msg) {
  connected = true;
  if (!tgEnabled() || msg.chat?.type !== 'private' || msg.from?.is_bot) return;
  if (!isAuthorized(msg.from?.id)) {
    if (parseCommand(msg.text || msg.caption) === '/start') {
      await bot.sendMessage(msg.chat.id, '⛔ У вас нет доступа к операторской консоли.').catch(() => {});
    }
    return;
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
  if (msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_closed || msg.forum_topic_reopened) return;

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
    io?.to(`ticket:${ticket.id}`).emit('message', message);
    io?.to('admin').emit('admin_new_message', { ticketId: ticket.id, message });
    io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
    await setTopicStatus(thread, ticket, cfg().telegramOpenEmoji).catch(() => {});
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
  const options = { message_thread_id: thread.thread_id };
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
    const operators = db.getActiveTelegramOperators.all()
      .filter(operator => isAuthorized(operator.telegram_user_id));
    if (settings.telegramAutoAssignSingleOperator &&
        ADMIN_IDS.size === 1 &&
        operators.length === 1) {
      await claimAndOpenTicket(fresh.id, operators[0].telegram_user_id);
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
  try {
    const sent = await sendMessageToThread(fresh, message, thread);
    if (!sent) throw new Error('Telegram did not confirm delivery');
    db.updateTelegramDelivery.run(String(thread.chat_id), sent.message_id, message.id);
    deliveryStats.delivered++;
    deliveryStats.lastSuccessAt = new Date().toISOString();
    if (message.sender === 'user') {
      await setTopicStatus(thread, fresh, settings.telegramWaitEmoji).catch(() => {});
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
  }
}

async function closeTicketFromTelegram(ticket) {
  const settings = cfg();
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  db.closeTicket.run(ticket.id);
  const fresh = db.getTicketById.get(ticket.id);
  io?.to(`ticket:${ticket.id}`).emit('ticket_closed', { by: 'support' });
  io?.to('admin').emit('admin_ticket_status', { ticketId: ticket.id, status: 'closed' });
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
  if (thread) {
    await setTopicStatus(thread, fresh, settings.telegramClosedEmoji).catch(() => {});
    await bot.sendMessage(thread.chat_id, settings.telegramClosedBySupportText, {
      message_thread_id: thread.thread_id,
      reply_markup: ticketKeyboard(fresh, 'closed')
    }).catch(() => {});
    if (settings.telegramCloseTopicOnClose) {
      await bot.closeForumTopic(thread.chat_id, thread.thread_id).catch(() => {});
    }
  }
  db.closeTelegramThreadsForTicket.run(ticket.id);
  const operator = fresh.assigned_operator_id
    ? db.getTelegramOperator.get(String(fresh.assigned_operator_id))
    : null;
  await updateAssignmentNotifications(fresh, operator);
  if (settings.telegramCleanupClosedTopics && settings.telegramCleanupClosedHours === 0) {
    scheduleCleanupOldTopics();
  }
}

async function reopenTicketFromTelegram(ticket, operatorOverride = null) {
  const settings = cfg();
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
  await setTopicStatus(thread, fresh, settings.telegramWaitEmoji).catch(() => {});
  await bot.sendMessage(thread.chat_id, settings.telegramReopenedText, {
    message_thread_id: thread.thread_id,
    reply_markup: ticketKeyboard(fresh, 'open')
  }).catch(() => {});
  await updateAssignmentNotifications(fresh, operator);
  io?.to(`ticket:${fresh.id}`).emit('ticket_reopened');
  io?.to('admin').emit('admin_ticket_status', { ticketId: fresh.id, status: 'open' });
  io?.to('admin').emit('admin_tickets', db.getTicketsForAdmin.all());
}

async function notifyTicketClosed(ticket) {
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  const fresh = db.getTicketById.get(ticket.id) || ticket;
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
  if (!thread) return;
  await bot.sendMessage(
    thread.chat_id,
    formatTemplate(cfg().telegramWarnInactivityText, extra),
    { message_thread_id: thread.thread_id }
  ).catch(() => {});
}

async function sendTyping(ticket) {
  const thread = db.getTelegramThreadForTicket.get(ticket.id);
  if (!thread) return;
  await bot.sendChatAction(thread.chat_id, 'typing', {
    message_thread_id: thread.thread_id
  }).catch(() => {});
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
  try {
    registeredOperators = db.getActiveTelegramOperators.all().length;
    unassignedTickets = db.db.prepare(
      `SELECT COUNT(*) AS count FROM tickets WHERE status='open' AND assigned_operator_id IS NULL`
    ).get().count;
    assignedOpenTickets = db.db.prepare(
      `SELECT COUNT(*) AS count FROM tickets WHERE status='open' AND assigned_operator_id IS NOT NULL`
    ).get().count;
  } catch {}
  return {
    mode: 'private',
    configured: !!TOKEN && ADMIN_IDS.size > 0,
    enabled: !!cfg().telegramEnabled,
    botStarted: !!bot,
    connected,
    botUsername: botUsername || null,
    threadedModeEnabled,
    richMessagesAvailable,
    allowedOperators: ADMIN_IDS.size,
    registeredOperators,
    unassignedTickets,
    assignedOpenTickets,
    miniAppConfigured: !!adminWebAppUrl(),
    pendingThreadCreates: creatingThreads.size,
    delivery: { ...deliveryStats, inFlight: forwardingMessages.size }
  };
}

async function createTopic(ticketId) {
  if (!tgEnabled()) return null;
  const ticket = db.getTicketById.get(ticketId);
  if (!ticket) return null;
  const operators = db.getActiveTelegramOperators.all()
    .filter(operator => isAuthorized(operator.telegram_user_id));
  if (!operators.length) {
    await operationalAlert(
      'telegram-no-operators',
      `Тикет ${shortId(ticket)} ждёт регистрации оператора`,
      'Откройте личный чат с ботом и выполните /start.'
    );
    return null;
  }
  if (cfg().telegramAutoAssignSingleOperator &&
      ADMIN_IDS.size === 1 &&
      operators.length === 1) {
    const thread = await claimAndOpenTicket(ticket.id, operators[0].telegram_user_id);
    return thread?.thread_id || null;
  }
  for (const operator of operators) {
    await sendAssignmentNotification(ticket, operator, { forceNew: false });
  }
  return null;
}

module.exports = {
  init,
  createTopic,
  forwardMessage,
  notifyTicketClosed,
  notifyTicketReopened,
  autoCloseTicket,
  sendTyping,
  warnInactivity,
  checkTopicAlive,
  status,
  notifyOperationalIssue: operationalAlert
};
