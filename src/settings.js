const db = require('./database');

const DEFAULTS = {
  timezone: 'Europe/Moscow',
  workStartHour: 8,
  workEndHour: 23,
  offhoursEnabled: true,
  offhoursBannerText: 'Сейчас нерабочее время (МСК). Ответим в рабочее время, но сообщение можно оставить сейчас.',
  offhoursRejectText: 'Сейчас нерабочее время. Ответим в рабочее время, но сообщение можно оставить сейчас.',

  supportName: 'Поддержка KV9RU',
  welcomeEnabled: true,
  welcomeDelayFirstMs: 1200,
  welcomeDelaySecondMs: 2800,
  welcomeText1: 'Добро пожаловать в службу поддержки KV9RU! 👋',
  welcomeText2: 'Чтобы мы могли быстрее разобраться и решить вашу проблему — пожалуйста, прикрепите скриншот из приложения VPN и опишите проблему максимально подробно 📸',

  messageRateLimitPerMinute: 20,
  uploadMaxMb: 50,

  inactivityEnabled: true,
  inactivityWarnMinutes: 45,
  inactivityCloseMinutes: 60,
  inactivityWarningText: 'Нет активности 45 минут — обращение будет закрыто через 15 минут.',
  inactivityCloseText: 'Обращение закрыто автоматически — нет активности в течение 1 часа.',

  telegramEnabled: true,
  telegramCreateTopics: true,
  telegramForwardUserMessages: true,
  telegramForwardAdminMessages: true,
  telegramForwardOperatorMessages: true,
  telegramDeleteRenameNotices: true,
  telegramPinNewTicketMessage: true,
  telegramCloseTopicOnClose: true,
  telegramReopenTopicOnReopen: true,
  telegramCleanupClosedTopics: true,
  telegramCleanupClosedHours: 24,
  telegramTopicNameTemplate: '{emoji} {name} • {date}',
  telegramNewEmoji: '❗',
  telegramOpenEmoji: '🔵',
  telegramWaitEmoji: '🔔',
  telegramClosedEmoji: '🗑️',
  telegramCloseButtonText: '🗑️ Закрыть тикет',
  telegramReopenButtonText: '🟢 Переоткрыть',
  telegramNewTicketText: '🎫 *Новое обращение*\n👤 *{name}*\n🆔 `{shortId}`\n📅 {dateTime}',
  telegramClosedByUserText: '🗑️ Закрыто пользователем',
  telegramClosedBySupportText: '🔴 Тикет закрыт',
  telegramReopenedText: '🔔 Тикет переоткрыт',
  telegramReopenedByUserText: '🔔 Переоткрыто пользователем',
  telegramAutoCloseText: '⏱ Тикет закрыт автоматически — нет активности {minutes} минут',
  telegramWarnInactivityText: '⚠️ Нет активности {warnMinutes} минут — тикет будет закрыт через {remainingMinutes} минут',
  telegramTopicDeletedAdminText: 'Тема удалена — создайте новый тикет'
};

const KEY_MAP = {
  timezone: 'timezone',
  workStartHour: 'work_start_hour',
  workEndHour: 'work_end_hour',
  offhoursEnabled: 'offhours_enabled',
  offhoursBannerText: 'offhours_banner_text',
  offhoursRejectText: 'offhours_reject_text',
  supportName: 'support_name',
  welcomeEnabled: 'welcome_enabled',
  welcomeDelayFirstMs: 'welcome_delay_first_ms',
  welcomeDelaySecondMs: 'welcome_delay_second_ms',
  welcomeText1: 'welcome_text_1',
  welcomeText2: 'welcome_text_2',
  messageRateLimitPerMinute: 'message_rate_limit_per_minute',
  uploadMaxMb: 'upload_max_mb',
  inactivityEnabled: 'inactivity_enabled',
  inactivityWarnMinutes: 'inactivity_warn_minutes',
  inactivityCloseMinutes: 'inactivity_close_minutes',
  inactivityWarningText: 'inactivity_warning_text',
  inactivityCloseText: 'inactivity_close_text',
  telegramEnabled: 'telegram_enabled',
  telegramCreateTopics: 'telegram_create_topics',
  telegramForwardUserMessages: 'telegram_forward_user_messages',
  telegramForwardAdminMessages: 'telegram_forward_admin_messages',
  telegramForwardOperatorMessages: 'telegram_forward_operator_messages',
  telegramDeleteRenameNotices: 'telegram_delete_rename_notices',
  telegramPinNewTicketMessage: 'telegram_pin_new_ticket_message',
  telegramCloseTopicOnClose: 'telegram_close_topic_on_close',
  telegramReopenTopicOnReopen: 'telegram_reopen_topic_on_reopen',
  telegramCleanupClosedTopics: 'telegram_cleanup_closed_topics',
  telegramCleanupClosedHours: 'telegram_cleanup_closed_hours',
  telegramTopicNameTemplate: 'telegram_topic_name_template',
  telegramNewEmoji: 'telegram_new_emoji',
  telegramOpenEmoji: 'telegram_open_emoji',
  telegramWaitEmoji: 'telegram_wait_emoji',
  telegramClosedEmoji: 'telegram_closed_emoji',
  telegramCloseButtonText: 'telegram_close_button_text',
  telegramReopenButtonText: 'telegram_reopen_button_text',
  telegramNewTicketText: 'telegram_new_ticket_text',
  telegramClosedByUserText: 'telegram_closed_by_user_text',
  telegramClosedBySupportText: 'telegram_closed_by_support_text',
  telegramReopenedText: 'telegram_reopened_text',
  telegramReopenedByUserText: 'telegram_reopened_by_user_text',
  telegramAutoCloseText: 'telegram_auto_close_text',
  telegramWarnInactivityText: 'telegram_warn_inactivity_text',
  telegramTopicDeletedAdminText: 'telegram_topic_deleted_admin_text'
};

const TYPES = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof value]));
const LEGACY_OFFHOURS_BANNER = 'Сейчас нерабочее время (МСК). Пожалуйста, напишите в рабочее время.';
const LEGACY_OFFHOURS_REJECT = 'Сейчас нерабочее время. Напишите, пожалуйста, в рабочее время.';

function clamp(n, min, max, fallback) {
  const value = Number(n);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function bool(value, fallback = false) {
  if (value === true || value === '1' || value === 'true' || value === 1) return true;
  if (value === false || value === '0' || value === 'false' || value === 0) return false;
  return fallback;
}

function sanitizeText(value, fallback, max = 3000) {
  const text = String(value ?? fallback ?? '').replace(/\r\n/g, '\n').trim();
  return text.slice(0, max);
}

function readRaw() {
  return Object.fromEntries(db.getAllSettings.all().map(row => [row.key, row.value]));
}

function normalize(input = {}) {
  const cfg = { ...DEFAULTS };
  for (const [publicKey, dbKey] of Object.entries(KEY_MAP)) {
    if (!(dbKey in input) && !(publicKey in input)) continue;
    const value = input[publicKey] ?? input[dbKey];
    if (TYPES[publicKey] === 'boolean') cfg[publicKey] = bool(value, DEFAULTS[publicKey]);
    else if (TYPES[publicKey] === 'number') cfg[publicKey] = Number(value);
    else cfg[publicKey] = sanitizeText(value, DEFAULTS[publicKey]);
  }

  cfg.timezone = sanitizeText(cfg.timezone, DEFAULTS.timezone, 80) || DEFAULTS.timezone;
  cfg.workStartHour = clamp(cfg.workStartHour, 0, 23, DEFAULTS.workStartHour);
  cfg.workEndHour = clamp(cfg.workEndHour, 1, 24, DEFAULTS.workEndHour);
  cfg.welcomeDelayFirstMs = clamp(cfg.welcomeDelayFirstMs, 0, 30000, DEFAULTS.welcomeDelayFirstMs);
  cfg.welcomeDelaySecondMs = clamp(cfg.welcomeDelaySecondMs, 0, 60000, DEFAULTS.welcomeDelaySecondMs);
  cfg.messageRateLimitPerMinute = clamp(cfg.messageRateLimitPerMinute, 1, 300, DEFAULTS.messageRateLimitPerMinute);
  cfg.uploadMaxMb = clamp(cfg.uploadMaxMb, 1, 50, DEFAULTS.uploadMaxMb);
  cfg.inactivityWarnMinutes = clamp(cfg.inactivityWarnMinutes, 1, 1440, DEFAULTS.inactivityWarnMinutes);
  cfg.inactivityCloseMinutes = clamp(cfg.inactivityCloseMinutes, cfg.inactivityWarnMinutes + 1, 2880, DEFAULTS.inactivityCloseMinutes);
  cfg.telegramCleanupClosedHours = clamp(cfg.telegramCleanupClosedHours, 1, 720, DEFAULTS.telegramCleanupClosedHours);

  cfg.supportName = sanitizeText(cfg.supportName, DEFAULTS.supportName, 80) || DEFAULTS.supportName;
  cfg.welcomeText1 = sanitizeText(cfg.welcomeText1, DEFAULTS.welcomeText1, 1000);
  cfg.welcomeText2 = sanitizeText(cfg.welcomeText2, DEFAULTS.welcomeText2, 1500);
  cfg.offhoursBannerText = sanitizeText(cfg.offhoursBannerText, DEFAULTS.offhoursBannerText, 1000);
  cfg.offhoursRejectText = sanitizeText(cfg.offhoursRejectText, DEFAULTS.offhoursRejectText, 1000);
  if (cfg.offhoursBannerText === LEGACY_OFFHOURS_BANNER) cfg.offhoursBannerText = DEFAULTS.offhoursBannerText;
  if (cfg.offhoursRejectText === LEGACY_OFFHOURS_REJECT) cfg.offhoursRejectText = DEFAULTS.offhoursRejectText;
  cfg.inactivityWarningText = sanitizeText(cfg.inactivityWarningText, DEFAULTS.inactivityWarningText, 1000);
  cfg.inactivityCloseText = sanitizeText(cfg.inactivityCloseText, DEFAULTS.inactivityCloseText, 1000);

  return cfg;
}

function toDbValue(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  return String(value ?? '');
}

function ensureDefaults() {
  for (const [publicKey, dbKey] of Object.entries(KEY_MAP)) {
    db.setSetting.run(dbKey, toDbValue(DEFAULTS[publicKey]));
  }
}

let ensured = false;
function loadSettings() {
  if (!ensured) {
    const raw = readRaw();
    for (const [publicKey, dbKey] of Object.entries(KEY_MAP)) {
      if (!(dbKey in raw)) db.setSetting.run(dbKey, toDbValue(DEFAULTS[publicKey]));
    }
    ensured = true;
  }
  return normalize(readRaw());
}

function saveSettings(payload = {}) {
  const cfg = normalize({ ...loadSettings(), ...payload });
  for (const [publicKey, dbKey] of Object.entries(KEY_MAP)) {
    db.setSetting.run(dbKey, toDbValue(cfg[publicKey]));
  }
  return cfg;
}

function formatTemplate(template, values = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);
}

module.exports = { DEFAULTS, loadSettings, saveSettings, formatTemplate, ensureDefaults };
