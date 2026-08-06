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
  welcomeText1Enabled: true,
  welcomeText2Enabled: true,
  welcomeText3Enabled: false,
  welcomeDelayFirstMs: 1200,
  welcomeDelaySecondMs: 2800,
  welcomeDelayThirdMs: 6500,
  welcomeText1: 'Добро пожаловать в службу поддержки KV9RU! 👋',
  welcomeText2: 'Чтобы мы могли быстрее разобраться и решить вашу проблему — пожалуйста, прикрепите скриншот из приложения VPN и опишите проблему максимально подробно 📸',
  welcomeText3: 'Если уже отправили детали — спасибо, оператор скоро подключится к диалогу.',

  operatorWaitEnabled: true,
  operatorWaitDelayMs: 180000,
  operatorWaitText: 'Я уже зову оператора на помощь. Ответ может занять чуть больше времени, но мы обязательно вернемся к вам в этом чате.',

  messageRateLimitPerMinute: 20,
  uploadMaxMb: 50,

  inactivityEnabled: true,
  inactivityWarnMinutes: 45,
  inactivityCloseMinutes: 60,
  inactivityWarningText: 'Нет активности 45 минут — тикет будет закрыт через 15 минут.',
  inactivityCloseText: 'Тикет закрыт автоматически — нет активности в течение 1 часа.',

  backupEnabled: true,
  backupIntervalHours: 24,
  backupRetention: 7,
  backupUploadsEnabled: true,
  uploadCleanupEnabled: true,
  uploadCleanupIntervalHours: 6,
  uploadOrphanGraceHours: 24,
  diskMonitoringEnabled: true,
  diskWarnPercent: 75,
  diskCriticalPercent: 90,
  operationalAlertsEnabled: true,
  operationalAlertCooldownMinutes: 15,

  telegramEnabled: true,
  telegramCreateTopics: true,
  telegramAutoAssignSingleOperator: true,
  telegramForwardUserMessages: true,
  telegramForwardAdminMessages: true,
  telegramForwardOperatorMessages: true,
  telegramDeleteRenameNotices: true,
  telegramPinNewTicketMessage: true,
  telegramCloseTopicOnClose: true,
  telegramCleanupClosedTopics: true,
  telegramCleanupClosedHours: 24,
  telegramUnansweredReminderEnabled: true,
  telegramUnansweredReminderMinutes: 3,
  telegramUnansweredRepeatMinutes: 5,
  telegramCustomerEnabled: true,
  telegramCustomerFilesEnabled: true,
  telegramCustomerDeliverReplies: true,
  telegramCustomerWelcomeText: 'Здравствуйте! Тикет создан — напишите вопрос, отправьте фото или файл, и поддержка ответит здесь.',
  telegramCustomerNewTicketText: 'Оператор уже получил уведомление. Напишите вопрос, отправьте фото или файл — вся переписка останется в этом чате до закрытия тикета.',
  telegramCustomerClosedText: '{reason}\n\nИстория диалога очищена. Нажмите кнопку ниже, когда понадобится помощь.',
  telegramCustomerClosedByUserText: 'Вы закрыли тикет.',
  telegramCustomerClosedBySupportText: 'Тикет закрыл оператор поддержки.',
  telegramCustomerClosedBySystemText: 'Тикет закрыт автоматически из-за отсутствия активности.',
  telegramCustomerClosePromptText: 'Если ваш вопрос решён, нажмите кнопку ниже — мы закроем обращение. Если нужна помощь, просто продолжайте диалог.',
  telegramCustomerCloseButtonText: '✅ Закрыть тикет',
  telegramCustomerNewButtonText: '🆕 Создать новый тикет',
  telegramCustomerSendCloseButtonText: '📨 Отправить кнопку закрытия',
  telegramRichTranscriptTitle: '💬 Диалог · {name}',
  telegramRichTranscriptSubtitle: 'Тикет {shortId} · {status}',
  telegramRichTranscriptMaxMessages: 8,
  telegramRichTranscriptMessageMaxChars: 360,
  telegramRichTranscriptShowAuthor: true,
  telegramRichTranscriptShowTime: true,
  telegramRichTranscriptSeparator: 'space',
  telegramRichTranscriptShowHeader: true,
  telegramRichTranscriptShowSubtitle: true,
  telegramRichTranscriptTitleSize: 'medium',
  telegramRichTranscriptTitleStyle: 'bold',
  telegramRichTranscriptSubtitleStyle: 'muted',
  telegramRichTranscriptMessageLayout: 'plain',
  telegramRichTranscriptMessageSize: 'normal',
  telegramRichTranscriptMessageHeaderStyle: 'bold',
  telegramRichTranscriptTimestampFormat: 'time',
  telegramRichTranscriptAuthorMode: 'grouped',
  telegramRichTranscriptGroupWindowMinutes: 10,
  telegramRichTranscriptGroupContinuation: 'time',
  telegramRichTranscriptGroupSpacing: 'compact',
  telegramRichTranscriptDensity: 'normal',
  telegramRichTranscriptOrder: 'oldest_first',
  telegramRichTranscriptUserLabel: '👤 {name}',
  telegramRichTranscriptOperatorLabel: '🛟 {name}',
  telegramRichTranscriptShowMediaLabel: true,
  telegramRichTranscriptShowOmittedNotice: true,
  telegramRichTranscriptFooter: '',
  telegramRichTranscriptEmptyText: 'Пока нет сообщений',
  telegramRichTranscriptEntryEffect: 'off',
  telegramRichTranscriptEntryEffectDelayMs: 180,
  telegramRichTranscriptEntryEffectText: 'Собираем диалог…',
  telegramTopicNameTemplate: '{emoji} {name} • {date}',
  telegramNewEmoji: '❗',
  telegramOpenEmoji: '🔵',
  telegramWaitEmoji: '🔔',
  telegramClosedEmoji: '🗑️',
  telegramCloseButtonText: '🗑️ Закрыть тикет',
  telegramCloseButtonStyle: 'danger',
  telegramCloseButtonEmojiId: '',
  telegramNewTicketText: '🎫 *Новый тикет*\n👤 *{name}*\n🆔 `{shortId}`\n📅 {dateTime}',
  telegramClosedByUserText: '🗑️ Закрыто пользователем',
  telegramClosedBySupportText: '🔴 Тикет закрыт',
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
  welcomeText1Enabled: 'welcome_text_1_enabled',
  welcomeText2Enabled: 'welcome_text_2_enabled',
  welcomeText3Enabled: 'welcome_text_3_enabled',
  welcomeDelayFirstMs: 'welcome_delay_first_ms',
  welcomeDelaySecondMs: 'welcome_delay_second_ms',
  welcomeDelayThirdMs: 'welcome_delay_third_ms',
  welcomeText1: 'welcome_text_1',
  welcomeText2: 'welcome_text_2',
  welcomeText3: 'welcome_text_3',
  operatorWaitEnabled: 'operator_wait_enabled',
  operatorWaitDelayMs: 'operator_wait_delay_ms',
  operatorWaitText: 'operator_wait_text',
  messageRateLimitPerMinute: 'message_rate_limit_per_minute',
  uploadMaxMb: 'upload_max_mb',
  inactivityEnabled: 'inactivity_enabled',
  inactivityWarnMinutes: 'inactivity_warn_minutes',
  inactivityCloseMinutes: 'inactivity_close_minutes',
  inactivityWarningText: 'inactivity_warning_text',
  inactivityCloseText: 'inactivity_close_text',
  backupEnabled: 'backup_enabled',
  backupIntervalHours: 'backup_interval_hours',
  backupRetention: 'backup_retention',
  backupUploadsEnabled: 'backup_uploads_enabled',
  uploadCleanupEnabled: 'upload_cleanup_enabled',
  uploadCleanupIntervalHours: 'upload_cleanup_interval_hours',
  uploadOrphanGraceHours: 'upload_orphan_grace_hours',
  diskMonitoringEnabled: 'disk_monitoring_enabled',
  diskWarnPercent: 'disk_warn_percent',
  diskCriticalPercent: 'disk_critical_percent',
  operationalAlertsEnabled: 'operational_alerts_enabled',
  operationalAlertCooldownMinutes: 'operational_alert_cooldown_minutes',
  telegramEnabled: 'telegram_enabled',
  telegramCreateTopics: 'telegram_create_topics',
  telegramAutoAssignSingleOperator: 'telegram_auto_assign_single_operator',
  telegramForwardUserMessages: 'telegram_forward_user_messages',
  telegramForwardAdminMessages: 'telegram_forward_admin_messages',
  telegramForwardOperatorMessages: 'telegram_forward_operator_messages',
  telegramDeleteRenameNotices: 'telegram_delete_rename_notices',
  telegramPinNewTicketMessage: 'telegram_pin_new_ticket_message',
  telegramCloseTopicOnClose: 'telegram_close_topic_on_close',
  telegramCleanupClosedTopics: 'telegram_cleanup_closed_topics',
  telegramCleanupClosedHours: 'telegram_cleanup_closed_hours',
  telegramUnansweredReminderEnabled: 'telegram_unanswered_reminder_enabled',
  telegramUnansweredReminderMinutes: 'telegram_unanswered_reminder_minutes',
  telegramUnansweredRepeatMinutes: 'telegram_unanswered_repeat_minutes',
  telegramCustomerEnabled: 'telegram_customer_enabled',
  telegramCustomerFilesEnabled: 'telegram_customer_files_enabled',
  telegramCustomerDeliverReplies: 'telegram_customer_deliver_replies',
  telegramCustomerWelcomeText: 'telegram_customer_welcome_text',
  telegramCustomerNewTicketText: 'telegram_customer_new_ticket_text',
  telegramCustomerClosedText: 'telegram_customer_closed_text',
  telegramCustomerClosedByUserText: 'telegram_customer_closed_by_user_text',
  telegramCustomerClosedBySupportText: 'telegram_customer_closed_by_support_text',
  telegramCustomerClosedBySystemText: 'telegram_customer_closed_by_system_text',
  telegramCustomerClosePromptText: 'telegram_customer_close_prompt_text',
  telegramCustomerCloseButtonText: 'telegram_customer_close_button_text',
  telegramCustomerNewButtonText: 'telegram_customer_new_button_text',
  telegramCustomerSendCloseButtonText: 'telegram_customer_send_close_button_text',
  telegramRichTranscriptTitle: 'telegram_rich_transcript_title',
  telegramRichTranscriptSubtitle: 'telegram_rich_transcript_subtitle',
  telegramRichTranscriptMaxMessages: 'telegram_rich_transcript_max_messages',
  telegramRichTranscriptMessageMaxChars: 'telegram_rich_transcript_message_max_chars',
  telegramRichTranscriptShowAuthor: 'telegram_rich_transcript_show_author',
  telegramRichTranscriptShowTime: 'telegram_rich_transcript_show_time',
  telegramRichTranscriptSeparator: 'telegram_rich_transcript_separator',
  telegramRichTranscriptShowHeader: 'telegram_rich_transcript_show_header',
  telegramRichTranscriptShowSubtitle: 'telegram_rich_transcript_show_subtitle',
  telegramRichTranscriptTitleSize: 'telegram_rich_transcript_title_size',
  telegramRichTranscriptTitleStyle: 'telegram_rich_transcript_title_style',
  telegramRichTranscriptSubtitleStyle: 'telegram_rich_transcript_subtitle_style',
  telegramRichTranscriptMessageLayout: 'telegram_rich_transcript_message_layout',
  telegramRichTranscriptMessageSize: 'telegram_rich_transcript_message_size',
  telegramRichTranscriptMessageHeaderStyle: 'telegram_rich_transcript_message_header_style',
  telegramRichTranscriptTimestampFormat: 'telegram_rich_transcript_timestamp_format',
  telegramRichTranscriptAuthorMode: 'telegram_rich_transcript_author_mode',
  telegramRichTranscriptGroupWindowMinutes: 'telegram_rich_transcript_group_window_minutes',
  telegramRichTranscriptGroupContinuation: 'telegram_rich_transcript_group_continuation',
  telegramRichTranscriptGroupSpacing: 'telegram_rich_transcript_group_spacing',
  telegramRichTranscriptDensity: 'telegram_rich_transcript_density',
  telegramRichTranscriptOrder: 'telegram_rich_transcript_order',
  telegramRichTranscriptUserLabel: 'telegram_rich_transcript_user_label',
  telegramRichTranscriptOperatorLabel: 'telegram_rich_transcript_operator_label',
  telegramRichTranscriptShowMediaLabel: 'telegram_rich_transcript_show_media_label',
  telegramRichTranscriptShowOmittedNotice: 'telegram_rich_transcript_show_omitted_notice',
  telegramRichTranscriptFooter: 'telegram_rich_transcript_footer',
  telegramRichTranscriptEmptyText: 'telegram_rich_transcript_empty_text',
  telegramRichTranscriptEntryEffect: 'telegram_rich_transcript_entry_effect',
  telegramRichTranscriptEntryEffectDelayMs: 'telegram_rich_transcript_entry_effect_delay_ms',
  telegramRichTranscriptEntryEffectText: 'telegram_rich_transcript_entry_effect_text',
  telegramTopicNameTemplate: 'telegram_topic_name_template',
  telegramNewEmoji: 'telegram_new_emoji',
  telegramOpenEmoji: 'telegram_open_emoji',
  telegramWaitEmoji: 'telegram_wait_emoji',
  telegramClosedEmoji: 'telegram_closed_emoji',
  telegramCloseButtonText: 'telegram_close_button_text',
  telegramCloseButtonStyle: 'telegram_close_button_style',
  telegramCloseButtonEmojiId: 'telegram_close_button_emoji_id',
  telegramNewTicketText: 'telegram_new_ticket_text',
  telegramClosedByUserText: 'telegram_closed_by_user_text',
  telegramClosedBySupportText: 'telegram_closed_by_support_text',
  telegramAutoCloseText: 'telegram_auto_close_text',
  telegramWarnInactivityText: 'telegram_warn_inactivity_text',
  telegramTopicDeletedAdminText: 'telegram_topic_deleted_admin_text'
};

const TYPES = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, typeof value]));
const LEGACY_OFFHOURS_BANNER = 'Сейчас нерабочее время (МСК). Пожалуйста, напишите в рабочее время.';
const LEGACY_OFFHOURS_REJECT = 'Сейчас нерабочее время. Напишите, пожалуйста, в рабочее время.';
const LEGACY_TELEGRAM_CUSTOMER_NEW_TICKET = '✅ Обращение создано. Оператор уже получил уведомление.';
const LEGACY_TELEGRAM_CUSTOMER_NEW_TICKET_CARD = '🎫 Обращение #{shortId} создано\n\nОператор уже получил уведомление. Когда вопрос будет решён, закройте обращение кнопкой ниже.';
const LEGACY_TELEGRAM_CUSTOMER_WELCOME = 'Здравствуйте! Напишите вопрос, отправьте фото или файл — поддержка ответит здесь.';
const LEGACY_TELEGRAM_CUSTOMER_CLOSED = 'Обращение закрыто. Напишите новое сообщение, чтобы снова обратиться в поддержку.';

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
  cfg.welcomeDelayThirdMs = clamp(cfg.welcomeDelayThirdMs, 0, 120000, DEFAULTS.welcomeDelayThirdMs);
  cfg.operatorWaitDelayMs = clamp(cfg.operatorWaitDelayMs, 10000, 3600000, DEFAULTS.operatorWaitDelayMs);
  cfg.messageRateLimitPerMinute = clamp(cfg.messageRateLimitPerMinute, 1, 300, DEFAULTS.messageRateLimitPerMinute);
  cfg.uploadMaxMb = clamp(cfg.uploadMaxMb, 1, 50, DEFAULTS.uploadMaxMb);
  cfg.inactivityWarnMinutes = clamp(cfg.inactivityWarnMinutes, 1, 1440, DEFAULTS.inactivityWarnMinutes);
  cfg.inactivityCloseMinutes = clamp(cfg.inactivityCloseMinutes, cfg.inactivityWarnMinutes + 1, 2880, DEFAULTS.inactivityCloseMinutes);
  cfg.backupIntervalHours = clamp(cfg.backupIntervalHours, 1, 720, DEFAULTS.backupIntervalHours);
  cfg.backupRetention = Math.round(clamp(cfg.backupRetention, 1, 365, DEFAULTS.backupRetention));
  cfg.uploadCleanupIntervalHours = clamp(cfg.uploadCleanupIntervalHours, 1, 720, DEFAULTS.uploadCleanupIntervalHours);
  cfg.uploadOrphanGraceHours = clamp(cfg.uploadOrphanGraceHours, 1, 8760, DEFAULTS.uploadOrphanGraceHours);
  cfg.diskWarnPercent = clamp(cfg.diskWarnPercent, 1, 98, DEFAULTS.diskWarnPercent);
  cfg.diskCriticalPercent = clamp(cfg.diskCriticalPercent, cfg.diskWarnPercent + 1, 100, DEFAULTS.diskCriticalPercent);
  cfg.operationalAlertCooldownMinutes = clamp(cfg.operationalAlertCooldownMinutes, 1, 1440, DEFAULTS.operationalAlertCooldownMinutes);
  cfg.telegramCleanupClosedHours = clamp(cfg.telegramCleanupClosedHours, 0, 720, DEFAULTS.telegramCleanupClosedHours);
  cfg.telegramUnansweredReminderMinutes = clamp(cfg.telegramUnansweredReminderMinutes, 1, 1440, DEFAULTS.telegramUnansweredReminderMinutes);
  cfg.telegramUnansweredRepeatMinutes = clamp(cfg.telegramUnansweredRepeatMinutes, 1, 1440, DEFAULTS.telegramUnansweredRepeatMinutes);
  cfg.telegramRichTranscriptMaxMessages = Math.round(clamp(cfg.telegramRichTranscriptMaxMessages, 1, 30, DEFAULTS.telegramRichTranscriptMaxMessages));
  cfg.telegramRichTranscriptMessageMaxChars = Math.round(clamp(cfg.telegramRichTranscriptMessageMaxChars, 80, 700, DEFAULTS.telegramRichTranscriptMessageMaxChars));
  cfg.telegramRichTranscriptGroupWindowMinutes = Math.round(clamp(
    cfg.telegramRichTranscriptGroupWindowMinutes,
    0,
    120,
    DEFAULTS.telegramRichTranscriptGroupWindowMinutes
  ));

  cfg.supportName = sanitizeText(cfg.supportName, DEFAULTS.supportName, 80) || DEFAULTS.supportName;
  cfg.welcomeText1 = sanitizeText(cfg.welcomeText1, DEFAULTS.welcomeText1, 1000);
  cfg.welcomeText2 = sanitizeText(cfg.welcomeText2, DEFAULTS.welcomeText2, 1500);
  cfg.welcomeText3 = sanitizeText(cfg.welcomeText3, DEFAULTS.welcomeText3, 1500);
  cfg.operatorWaitText = sanitizeText(cfg.operatorWaitText, DEFAULTS.operatorWaitText, 1500);
  cfg.offhoursBannerText = sanitizeText(cfg.offhoursBannerText, DEFAULTS.offhoursBannerText, 1000);
  cfg.offhoursRejectText = sanitizeText(cfg.offhoursRejectText, DEFAULTS.offhoursRejectText, 1000);
  if (cfg.offhoursBannerText === LEGACY_OFFHOURS_BANNER) cfg.offhoursBannerText = DEFAULTS.offhoursBannerText;
  if (cfg.offhoursRejectText === LEGACY_OFFHOURS_REJECT) cfg.offhoursRejectText = DEFAULTS.offhoursRejectText;
  cfg.inactivityWarningText = sanitizeText(cfg.inactivityWarningText, DEFAULTS.inactivityWarningText, 1000);
  cfg.inactivityCloseText = sanitizeText(cfg.inactivityCloseText, DEFAULTS.inactivityCloseText, 1000);
  cfg.telegramCustomerWelcomeText = sanitizeText(cfg.telegramCustomerWelcomeText, DEFAULTS.telegramCustomerWelcomeText, 1500);
  cfg.telegramCustomerNewTicketText = sanitizeText(cfg.telegramCustomerNewTicketText, DEFAULTS.telegramCustomerNewTicketText, 1000);
  if (cfg.telegramCustomerWelcomeText === LEGACY_TELEGRAM_CUSTOMER_WELCOME) {
    cfg.telegramCustomerWelcomeText = DEFAULTS.telegramCustomerWelcomeText;
  }
  if (cfg.telegramCustomerNewTicketText === LEGACY_TELEGRAM_CUSTOMER_NEW_TICKET ||
      cfg.telegramCustomerNewTicketText === LEGACY_TELEGRAM_CUSTOMER_NEW_TICKET_CARD) {
    cfg.telegramCustomerNewTicketText = DEFAULTS.telegramCustomerNewTicketText;
  }
  cfg.telegramCustomerClosedText = sanitizeText(cfg.telegramCustomerClosedText, DEFAULTS.telegramCustomerClosedText, 1000);
  if (cfg.telegramCustomerClosedText === LEGACY_TELEGRAM_CUSTOMER_CLOSED) {
    cfg.telegramCustomerClosedText = DEFAULTS.telegramCustomerClosedText;
  }
  cfg.telegramCustomerClosedByUserText = sanitizeText(cfg.telegramCustomerClosedByUserText, DEFAULTS.telegramCustomerClosedByUserText, 500);
  cfg.telegramCustomerClosedBySupportText = sanitizeText(cfg.telegramCustomerClosedBySupportText, DEFAULTS.telegramCustomerClosedBySupportText, 500);
  cfg.telegramCustomerClosedBySystemText = sanitizeText(cfg.telegramCustomerClosedBySystemText, DEFAULTS.telegramCustomerClosedBySystemText, 500);
  cfg.telegramCustomerClosePromptText = sanitizeText(cfg.telegramCustomerClosePromptText, DEFAULTS.telegramCustomerClosePromptText, 500);
  cfg.telegramCustomerCloseButtonText = sanitizeText(cfg.telegramCustomerCloseButtonText, DEFAULTS.telegramCustomerCloseButtonText, 64) || DEFAULTS.telegramCustomerCloseButtonText;
  cfg.telegramCustomerNewButtonText = sanitizeText(cfg.telegramCustomerNewButtonText, DEFAULTS.telegramCustomerNewButtonText, 64) || DEFAULTS.telegramCustomerNewButtonText;
  cfg.telegramCustomerSendCloseButtonText = sanitizeText(cfg.telegramCustomerSendCloseButtonText, DEFAULTS.telegramCustomerSendCloseButtonText, 64) || DEFAULTS.telegramCustomerSendCloseButtonText;
  cfg.telegramRichTranscriptTitle = sanitizeText(cfg.telegramRichTranscriptTitle, DEFAULTS.telegramRichTranscriptTitle, 160) || DEFAULTS.telegramRichTranscriptTitle;
  cfg.telegramRichTranscriptSubtitle = sanitizeText(cfg.telegramRichTranscriptSubtitle, DEFAULTS.telegramRichTranscriptSubtitle, 240);
  const allowedTranscriptSeparators = new Set(['space', 'dots', 'line']);
  cfg.telegramRichTranscriptSeparator = allowedTranscriptSeparators.has(cfg.telegramRichTranscriptSeparator)
    ? cfg.telegramRichTranscriptSeparator
    : DEFAULTS.telegramRichTranscriptSeparator;
  const transcriptOptions = {
    telegramRichTranscriptTitleSize: ['large', 'medium', 'small', 'compact'],
    telegramRichTranscriptTitleStyle: ['bold', 'plain', 'italic'],
    telegramRichTranscriptSubtitleStyle: ['muted', 'plain', 'code'],
    telegramRichTranscriptMessageLayout: ['plain', 'quote', 'compact'],
    telegramRichTranscriptMessageSize: ['compact', 'normal', 'large'],
    telegramRichTranscriptMessageHeaderStyle: ['bold', 'plain', 'italic'],
    telegramRichTranscriptTimestampFormat: ['time', 'date_time'],
    telegramRichTranscriptAuthorMode: ['every', 'grouped', 'hidden'],
    telegramRichTranscriptGroupContinuation: ['time', 'none'],
    telegramRichTranscriptGroupSpacing: ['compact', 'inherit'],
    telegramRichTranscriptDensity: ['compact', 'normal', 'airy'],
    telegramRichTranscriptOrder: ['oldest_first', 'newest_first'],
    telegramRichTranscriptEntryEffect: ['off', 'draft']
  };
  for (const [key, allowed] of Object.entries(transcriptOptions)) {
    cfg[key] = allowed.includes(cfg[key]) ? cfg[key] : DEFAULTS[key];
  }
  cfg.telegramRichTranscriptUserLabel = sanitizeText(cfg.telegramRichTranscriptUserLabel, DEFAULTS.telegramRichTranscriptUserLabel, 80) || DEFAULTS.telegramRichTranscriptUserLabel;
  // The original preset rendered the literal word "Клиент" even though each
  // ticket already has a name. Upgrade that preset, but leave custom labels intact.
  if (cfg.telegramRichTranscriptUserLabel === '👤 Клиент') {
    cfg.telegramRichTranscriptUserLabel = DEFAULTS.telegramRichTranscriptUserLabel;
  }
  cfg.telegramRichTranscriptOperatorLabel = sanitizeText(cfg.telegramRichTranscriptOperatorLabel, DEFAULTS.telegramRichTranscriptOperatorLabel, 120) || DEFAULTS.telegramRichTranscriptOperatorLabel;
  cfg.telegramRichTranscriptFooter = sanitizeText(cfg.telegramRichTranscriptFooter, DEFAULTS.telegramRichTranscriptFooter, 240);
  cfg.telegramRichTranscriptEmptyText = sanitizeText(cfg.telegramRichTranscriptEmptyText, DEFAULTS.telegramRichTranscriptEmptyText, 240) || DEFAULTS.telegramRichTranscriptEmptyText;
  cfg.telegramRichTranscriptEntryEffectDelayMs = clamp(cfg.telegramRichTranscriptEntryEffectDelayMs, 0, 1200, DEFAULTS.telegramRichTranscriptEntryEffectDelayMs);
  cfg.telegramRichTranscriptEntryEffectText = sanitizeText(cfg.telegramRichTranscriptEntryEffectText, DEFAULTS.telegramRichTranscriptEntryEffectText, 120) || DEFAULTS.telegramRichTranscriptEntryEffectText;
  const allowedButtonStyles = new Set(['', 'danger', 'success', 'primary']);
  cfg.telegramCloseButtonStyle = allowedButtonStyles.has(cfg.telegramCloseButtonStyle) ? cfg.telegramCloseButtonStyle : DEFAULTS.telegramCloseButtonStyle;
  cfg.telegramCloseButtonEmojiId = sanitizeText(cfg.telegramCloseButtonEmojiId, '', 128);

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
