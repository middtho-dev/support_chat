'use strict';

const DEFAULT_TEMPLATES = [
  { label: 'Приветствие', text: 'Добрый день! Чем могу помочь?' },
  { label: 'Ожидание', text: 'Уточняю информацию, вернусь к вам в ближайшее время.' },
  { label: 'Переустановка', text: 'Попробуйте переустановить VPN-клиент и перезагрузить устройство.' },
  { label: 'Смена сервера', text: 'Попробуйте сменить сервер в настройках приложения.' },
  { label: 'Скриншот', text: 'Пришлите, пожалуйста, скриншот ошибки — это ускорит решение.' },
  { label: 'Завершение', text: 'Спасибо, что написали в поддержку KV9RU! Будем рады помочь снова.' }
];
const COLORS = ['#2563eb','#7c3aed','#db2777','#dc2626','#d97706','#059669','#0891b2','#9333ea'];
const S = { token: null, tickets: [], filter: 'open', search: '', current: null, messages: [], settings: null, operators: [], permissions: { canManageSettings: false }, settingsDirty: false, settingsSaving: false, settingsFilter: 'all', settingsQuery: '', settingsSnapshot: '', settingsLastSavedAt: null, maintenance: null, systemHealth: null, templates: loadTemplates(), view: 'chat', lastDate: '', file: null, uploading: false, lastTyping: 0, pendingReply: null };
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);
const TG = window.Telegram?.WebApp || null;
const PAGE_PARAMS = new URLSearchParams(location.search);
const IS_TG_MINI = !!TG?.initData ||
  PAGE_PARAMS.get('tg') === '1' ||
  ['/miniapp', '/tg-admin'].includes(location.pathname.replace(/\/+$/, '') || '/');
let pendingTargetTicketId = PAGE_PARAMS.get('ticket') || '';
let telegramFullscreenRequested = false;
const TELEGRAM_FULLSCREEN_TOP_CLEARANCE = 84;
let miniRefreshTimer = null;
let miniRefreshPending = false;
let miniRefreshSequence = 0;

const esc = value => value == null ? '' : String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
function adminMediaFailed(el) {
  if (!el || el.dataset.failed) return;
  el.dataset.failed = '1';
  const url = el.currentSrc || el.src;
  const fallback = document.createElement('a');
  fallback.className = 'file media-load-error';
  fallback.href = url;
  fallback.target = '_blank';
  fallback.rel = 'noopener noreferrer';
  fallback.innerHTML = '<span class="file-ico">!</span><span>Медиа не загрузилось — открыть</span>';
  el.replaceWith(fallback);
}
const LINK_RE = /\b((?:https?:\/\/|www\.)[^\s<>"']+|(?:vless|vmess|trojan|ss|ssr|hysteria2|hy2|tuic|wireguard|tg):\/\/[^\s<>"']+)/gi;
function linkify(value) {
  const text = String(value ?? '');
  let html = '', last = 0, match;
  LINK_RE.lastIndex = 0;
  while ((match = LINK_RE.exec(text))) {
    const raw = match[0];
    html += esc(text.slice(last, match.index));
    let url = raw, tail = '';
    while (url && /[.,!?;:)\]}]+$/.test(url)) { tail = url.slice(-1) + tail; url = url.slice(0, -1); }
    if (url) {
      const href = /^www\./i.test(url) ? `https://${url}` : url;
      html += `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>${esc(tail)}`;
    } else {
      html += esc(raw);
    }
    last = match.index + raw.length;
  }
  html += esc(text.slice(last));
  return html;
}
const fmtTime = date => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDate = date => date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
function parseServerDate(value) {
  if (value instanceof Date) return value;
  const raw = String(value || '');
  if (!raw) return new Date(NaN);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  return new Date(normalized);
}
const isMobileLayout = () => window.matchMedia(IS_TG_MINI ? '(max-width: 720px)' : '(max-width: 560px)').matches;
function timeAgo(iso) { const sec = Math.max(0, Math.floor((Date.now() - parseServerDate(iso).getTime()) / 1000)); if (sec < 60) return 'сейчас'; if (sec < 3600) return `${Math.floor(sec / 60)} мин`; if (sec < 86400) return `${Math.floor(sec / 3600)} ч`; return `${Math.floor(sec / 86400)} д`; }
function avatarColor(name = '') { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff; return COLORS[h % COLORS.length]; }
function initials(name = '') { return (name.trim() || '?').slice(0, 2).toUpperCase(); }
function loadTemplates() { try { return JSON.parse(localStorage.getItem('admin_templates')) || DEFAULT_TEMPLATES; } catch { return DEFAULT_TEMPLATES; } }
function saveTemplates() { localStorage.setItem('admin_templates', JSON.stringify(S.templates)); }
let toastTimer;
function toast(text, type = 'info') { const el = $('toast'); clearTimeout(toastTimer); el.textContent = text; el.style.borderColor = type === 'err' ? 'rgba(251,113,133,.45)' : type === 'ok' ? 'rgba(52,211,153,.45)' : ''; el.classList.add('on'); toastTimer = setTimeout(() => el.classList.remove('on'), 2800); }
function setConn(state) { $('cdot').className = `dot ${state}`; $('ctxt').textContent = state === 'on' ? 'онлайн' : state === 'off' ? 'нет соединения' : 'подключение'; }

async function init() {
  initTelegramMiniApp();
  bindStaticUi();
  renderSettings();
  renderTemplates();
  renderMaintenance();
  setInterval(renderRelativeTimes, 30000);
  setInterval(() => { if (S.view === 'health' && S.token) loadMaintenance(); }, 20000);
  if (IS_TG_MINI) {
    sessionStorage.removeItem('admin_token');
    clearMiniAppCache();
    await loginWithTelegram();
    return;
  }
  const saved = sessionStorage.getItem('admin_token');
  if (saved) { S.token = saved; setConn(''); socket.connect(); }
  else setTimeout(() => $('tok')?.focus(), 100);
}

function clearMiniAppCache() {
  if (!('caches' in window)) return;
  caches.keys()
    .then(keys => Promise.all(keys.map(key => caches.delete(key))))
    .catch(() => {});
}

function initTelegramMiniApp() {
  if (!IS_TG_MINI) return;
  document.body.classList.add('tg-mini');
  document.title = 'Админка';
  document.querySelector('.auth-card h1').textContent = 'Админка';
  document.querySelector('.auth-card p').textContent = 'Вход только через ваш Telegram';
  document.querySelector('.top h1').textContent = 'Админка';
  document.querySelector('.top .brand p').textContent = 'Telegram Mini App';
  $('tok').style.display = 'none';
  $('lbtn').style.display = 'none';
  $('lerr').textContent = 'Проверяю Telegram-доступ...';
  document.documentElement.style.setProperty('color-scheme', 'dark');
  if (!TG) return;

  TG.ready();
  TG.expand();
  try {
    if (typeof TG.requestFullscreen === 'function') {
      telegramFullscreenRequested = true;
      TG.requestFullscreen();
    }
  } catch {}
  TG.disableVerticalSwipes?.();
  applyTelegramTheme();
  applyTelegramViewport();
  TG.onEvent?.('themeChanged', applyTelegramTheme);
  TG.onEvent?.('viewportChanged', applyTelegramViewport);
  TG.onEvent?.('safeAreaChanged', applyTelegramViewport);
  TG.onEvent?.('contentSafeAreaChanged', applyTelegramViewport);
  TG.onEvent?.('fullscreenChanged', updateTelegramFullscreenViewport);
  TG.BackButton?.onClick(handleTelegramBack);
}

async function loginWithTelegram() {
  if (!TG?.initData) {
    $('lerr').textContent = 'Откройте админку через Telegram Mini App.';
    return;
  }
  try {
    const response = await fetch('/api/admin/telegram-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ initData: TG.initData })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.adminSessionToken) {
      throw new Error(data.error || 'Нет доступа');
    }
    S.token = data.adminSessionToken;
    S.permissions = data.permissions || S.permissions;
    $('lerr').textContent = '';
    setConn('');
    socket.connect();
  } catch (error) {
    TG?.HapticFeedback?.notificationOccurred?.('error');
    $('lerr').textContent = error.message || 'Не удалось войти через Telegram';
    setConn('off');
  }
}

function applyTelegramTheme() {
  if (!TG?.themeParams) return;
  const p = TG.themeParams;
  const root = document.documentElement.style;
  if (p.bg_color) root.setProperty('--tg-bg', p.bg_color);
  if (p.text_color) root.setProperty('--text', p.text_color);
  if (p.hint_color) root.setProperty('--muted', p.hint_color);
  if (p.button_color) root.setProperty('--blue2', p.button_color);
  if (p.button_text_color) root.setProperty('--button-text', p.button_text_color);
}

function applyTelegramViewport() {
  if (!IS_TG_MINI) return;
  const stableHeight = Math.round(
    Number(TG?.viewportStableHeight) ||
    Number(TG?.viewportHeight) ||
    window.innerHeight
  );
  if (stableHeight > 0) {
    document.documentElement.style.setProperty('--tg-stable-height', `${stableHeight}px`);
  }
  const contentInsets = TG?.contentSafeAreaInset || {};
  const safeInsets = TG?.safeAreaInset || {};
  const topInset = Math.max(
    0,
    Number(contentInsets.top) || 0,
    Number(safeInsets.top) || 0,
    (TG?.isFullscreen || telegramFullscreenRequested) ? TELEGRAM_FULLSCREEN_TOP_CLEARANCE : 0
  );
  const bottomInset = Math.max(
    0,
    Number(contentInsets.bottom) || 0,
    Number(safeInsets.bottom) || 0
  );
  document.documentElement.style.setProperty('--tg-top-ui', `${Math.round(topInset)}px`);
  document.documentElement.style.setProperty('--tg-bottom-ui', `${Math.round(bottomInset)}px`);
}

function updateTelegramFullscreenViewport(payload = {}) {
  if (typeof payload.isFullscreen === 'boolean') telegramFullscreenRequested = payload.isFullscreen;
  if (typeof payload.is_fullscreen === 'boolean') telegramFullscreenRequested = payload.is_fullscreen;
  applyTelegramViewport();
}

function tgImpact(style = 'light') {
  TG?.HapticFeedback?.impactOccurred?.(style);
}

function handleTelegramBack() {
  if ($('main')?.classList.contains('open')) {
    leaveCurrentTicket();
    return;
  }
  if (S.view !== 'chat') {
    setView('chat');
    updateTelegramBackButton();
  }
}

function updateTelegramBackButton() {
  if (!TG?.BackButton) return;
  const visible = $('main')?.classList.contains('open') || S.view !== 'chat';
  visible ? TG.BackButton.show() : TG.BackButton.hide();
}

function bindStaticUi() {
  $('login-form').addEventListener('submit', event => { event.preventDefault(); login(); });
  $('logout-btn').addEventListener('click', logout);
  $('srch').addEventListener('input', () => { S.search = $('srch').value.trim().toLowerCase(); renderSidebar(); });
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => setFilter(btn.dataset.tab)));
  document.querySelectorAll('.navbtn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('back').addEventListener('click', leaveCurrentTicket);
  $('cv-toggle').addEventListener('click', toggleTicketStatus);
  $('mobile-ticket-back').addEventListener('click', leaveCurrentTicket);
  $('mobile-ticket-card').addEventListener('click', () => window.adminOpenTicketCard?.());
  $('mobile-ticket-toggle').addEventListener('click', toggleTicketStatus);
  document.addEventListener('click', event => { if (!event.target.closest('.pop') && event.target !== $('quick')) document.querySelectorAll('.pop').forEach(p => p.remove()); });
  window.addEventListener('beforeunload', event => {
    if (!S.settingsDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function login() { const token = $('tok').value.trim(); if (!token) return; S.token = token; $('lbtn').disabled = true; $('lerr').textContent = ''; setConn(''); socket.connect(); }
function logout() { sessionStorage.removeItem('admin_token'); socket.disconnect(); S.token = null; S.tickets = []; S.current = null; S.messages = []; S.permissions = { canManageSettings: false }; document.querySelector('.navbtn[data-view="settings"]')?.setAttribute('hidden', ''); document.body.classList.remove('ticket-open'); TG?.BackButton?.hide?.(); $('app').style.display = 'none'; $('login').style.display = 'grid'; $('tok').value = ''; $('lbtn').disabled = false; setConn('off'); }

socket.on('connect', () => { setConn('on'); if (S.token) socket.emit('admin_auth', { token: S.token }); });
socket.on('disconnect', () => setConn('off'));
socket.io.on('reconnect_attempt', () => setConn('connecting'));

socket.on('admin_auth_ok', auth => {
  S.permissions = auth?.permissions || S.permissions;
  const settingsNav = document.querySelector('.navbtn[data-view="settings"]');
  if (settingsNav) settingsNav.hidden = !S.permissions.canManageSettings;
  sessionStorage.setItem('admin_token', S.token);
  $('login').style.display = 'none';
  $('app').style.display = 'grid';
  tgImpact('medium');
  if (S.permissions.canManageSettings) {
    socket.emit('admin_get_settings');
    requestOperators();
  }
  startMiniAppRefresh();
});
socket.on('admin_settings', s => {
  S.settings = s || {};
  window.supportAdminSettings = S.settings;
  renderSettings();
});
socket.on('admin_settings_updated', s => {
  if (S.settingsDirty) {
    toast('Настройки изменены другим оператором. Сохраните или отмените свои изменения.', 'err');
    return;
  }
  S.settings = s || {};
  window.supportAdminSettings = S.settings;
  if (S.view === 'settings') renderSettings();
});
socket.on('admin_settings_forbidden', () => {
  S.permissions = { ...S.permissions, canManageSettings: false };
  document.querySelector('.navbtn[data-view="settings"]')?.setAttribute('hidden', '');
});
socket.on('admin_operators_updated', () => {
  if (S.permissions.canManageSettings) requestOperators();
});

socket.on('admin_auth_error', () => {
  sessionStorage.removeItem('admin_token');
  $('lbtn').disabled = false;
  $('lerr').textContent = 'Неверный токен доступа';
  setConn('off');
  socket.disconnect();
});

socket.on('admin_tickets', tickets => {
  S.tickets = tickets;
  renderSidebar();
  if (pendingTargetTicketId && S.tickets.some(ticket => ticket.id === pendingTargetTicketId)) {
    const target = pendingTargetTicketId;
    pendingTargetTicketId = '';
    openTicket(target);
  }
});

socket.on('admin_new_ticket', ticket => {
  S.tickets.unshift(ticket);
  renderSidebar();
});

socket.on('admin_new_message', ({ ticketId, message }) => {
  const t = S.tickets.find(t => t.id === ticketId);
  if (t) {
    t.last_msg      = message.content;
    t.last_sender   = message.sender;
    t.last_msg_type = message.message_type;
    t.last_activity = message.created_at;
    if (message.sender === 'user' && ticketId !== S.current?.id) {
      t.unread_count = (t.unread_count || 0) + 1;
    }
  }
  renderSidebar();
  if (ticketId === S.current?.id) {
    if (message?.id && S.messages.some(existing => existing.id === message.id)) return;
    S.messages.push(message);
    appendMessage(message, true);
  }
});

socket.on('admin_ticket_messages', ({ ticketId, messages, ticket }) => {
  if (ticketId !== S.current?.id) return;
  S.current = ticket;
  S.messages = Array.isArray(messages) ? messages : [];
  renderConversation();
  renderChatHeader();
});

socket.on('admin_ticket_status', ({ ticketId, status }) => {
  const t = S.tickets.find(t => t.id === ticketId);
  if (t) t.status = status;
  renderSidebar();
  if (ticketId === S.current?.id) {
    S.current.status = status;
    renderChatHeader();
  }
});

socket.on('admin_message_reactions', ({ ticketId, messageId, reactions }) => {
  if (ticketId !== S.current?.id) return;
  const msg = S.messages.find(m => m.id === messageId);
  if (!msg) return;
  msg.reactions = JSON.stringify(Array.isArray(reactions) ? reactions : []);
  renderConversation();
});

socket.on('admin_error', ({ message }) => toast(message, 'err'));
socket.on('operational_alert', ({ message, details }) => toast(`${message}${details ? `: ${details}` : ''}`, 'err', 8000));
socket.on('ticket_reminder', ({ waitingMinutes }) => toast(`Оператору отправлено напоминание: клиент ждёт ${waitingMinutes} мин`));
socket.on('maintenance_updated', status => {
  S.maintenance = status;
  if (S.view === 'health') renderMaintenance();
});

socket.on('admin_user_typing', ({ ticketId }) => {
  if (ticketId !== S.current?.id) return;
  showUserTyping();
});

let _userTypingHide = null;
function showUserTyping() {
  const bar = $('typing');
  if (!bar) return;
  bar.style.display = '';
  clearTimeout(_userTypingHide);
  _userTypingHide = setTimeout(() => { if (bar) bar.style.display = 'none'; }, 3000);
}

// ── Sidebar ────────────────────────────────────────────────────────────────

function setFilter(filter) {
  S.filter = filter || 'open';
  document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('on', btn.dataset.tab === S.filter));
  renderSidebar();
}

function setView(view) {
  if (view === 'settings' && !S.permissions.canManageSettings) {
    return toast('У вас нет доступа к настройкам', 'err');
  }
  S.view = view || 'chat';
  tgImpact('light');
  document.querySelectorAll('.navbtn').forEach(btn => btn.classList.toggle('on', btn.dataset.view === S.view));
  $('settings').classList.toggle('on', S.view === 'settings');
  $('templates').classList.toggle('on', S.view === 'templates');
  $('health').classList.toggle('on', S.view === 'health');

  if (S.view === 'chat') {
    $('welcome').style.display = S.current ? 'none' : 'grid';
    $('chat').style.display = S.current ? 'flex' : 'none';
    if (isMobileLayout() && !S.current) $('main').classList.remove('open');
  } else {
    document.body.classList.remove('ticket-open');
    $('welcome').style.display = 'none';
    $('chat').style.display = 'none';
    $('main').classList.add('open');
  }
  if (S.view === 'health') loadMaintenance();
  if (S.view === 'settings' && S.permissions.canManageSettings) requestOperators();
  updateTelegramBackButton();
}

function renderSidebar() {
  const open = S.tickets.filter(t => t.status === 'open').length;
  const unread = S.tickets.reduce((sum, t) => sum + (t.status === 'open' && t.unread_count ? 1 : 0), 0);
  $('m-open').textContent = open; $('m-unread').textContent = unread; $('m-all').textContent = S.tickets.length;
  const items = S.tickets.filter(t => (S.filter === 'all' || t.status === S.filter) && (!S.search || `${t.user_name} ${t.id}`.toLowerCase().includes(S.search)));
  const list = $('tlist');
  if (!items.length) { list.innerHTML = `<div class="empty">${S.search ? 'Ничего не найдено' : 'Заявок в этом разделе нет'}</div>`; return; }
  list.innerHTML = items.map(ticketHtml).join('');
  list.querySelectorAll('.ticket').forEach(el => el.addEventListener('click', () => openTicket(el.dataset.id)));
}
function ticketHtml(t) { const ts = t.last_activity || t.created_at; const badge = t.unread_count > 0 ? `<div class="badge">${t.unread_count}</div>` : ''; const source = t.source === 'telegram' ? '<span class="ticket-channel">TG</span>' : ''; return `<button class="ticket ${S.current?.id === t.id ? 'on' : ''}" data-id="${esc(t.id)}"><div class="avatar ${t.status === 'closed' ? 'closed' : t.unread_count > 0 ? 'wait' : ''}" style="background:${avatarColor(t.user_name)}">${esc(initials(t.user_name))}</div><div><div class="tname"><span>${esc(t.user_name)}</span>${source}</div><div class="tlast">${preview(t)}</div></div><div><div class="time" data-ts="${esc(ts)}">${timeAgo(ts)}</div>${badge}</div></button>`; }
function preview(t) { if (!t.last_msg && !t.last_msg_type) return '<span>нет сообщений</span>'; const prefix = t.last_sender === 'support' ? 'Вы: ' : ''; if (t.last_msg_type && t.last_msg_type !== 'text') return esc(prefix + (t.last_msg_type === 'image' ? 'Фото' : t.last_msg_type === 'video' ? 'Видео' : t.last_msg_type === 'audio' ? 'Аудио' : 'Файл')); return esc(prefix + (t.last_msg || '').slice(0, 80)); }
function renderRelativeTimes() { document.querySelectorAll('[data-ts]').forEach(el => { el.textContent = timeAgo(el.dataset.ts); }); }

function leaveCurrentTicket() {
  $('main').classList.remove('open');
  document.body.classList.remove('ticket-open');
  $('mobile-ticket-top').setAttribute('aria-hidden', 'true');
  updateTelegramBackButton();
}

function openTicket(id) { const ticket = S.tickets.find(t => t.id === id); if (!ticket) return; S.current = ticket; S.current.unread_count = 0; S.messages = []; S.lastDate = ''; setView('chat'); $('main').classList.add('open'); document.body.classList.add('ticket-open'); $('mobile-ticket-top').setAttribute('aria-hidden', 'false'); $('welcome').style.display = 'none'; $('chat').style.display = 'flex'; $('cv-msgs').innerHTML = '<div class="empty">Загрузка сообщений...</div>'; tgImpact('medium'); updateTelegramBackButton(); renderSidebar(); renderChatHeader(); socket.emit('admin_open_ticket', { ticketId: id }); }
function renderChatHeader() {
  if (!S.current) return;
  const t = S.current;
  const legacyDeleted = S.settings?.telegramMode !== 'private' && !!t.telegram_topic_deleted;
  const assignee = t.assigned_operator_name ||
    (t.assigned_operator_id ? `Telegram ID ${t.assigned_operator_id}` : 'не назначен');
  $('cv-av').style.background = avatarColor(t.user_name);
  $('cv-av').textContent = initials(t.user_name);
  $('cv-av').className = `avatar ${t.status === 'closed' ? 'closed' : ''}`;
  $('cv-name').textContent = t.user_name;
  const channel = t.source === 'telegram' ? 'Telegram' : 'сайт';
  $('cv-sub').textContent = `${channel} · #${t.id.slice(0, 8)} · ${fmtDate(parseServerDate(t.created_at))} · ${t.status === 'open' ? 'открыто' : 'закрыто'} · оператор: ${assignee}`;
  const firstResponse = S.messages.find(message => message.sender === 'support' && !Number(message.is_auto));
  const pending = t.status === 'open' && (t.unread_count > 0 || t.last_sender === 'user' || !firstResponse);
  const activity = timeAgo(t.last_activity || t.created_at);
  $('mobile-ticket-avatar').style.background = avatarColor(t.user_name);
  $('mobile-ticket-avatar').textContent = initials(t.user_name);
  $('mobile-ticket-avatar').className = `avatar ${t.status === 'closed' ? 'closed' : pending ? 'wait' : ''}`;
  $('mobile-ticket-name').textContent = t.user_name;
  $('mobile-ticket-summary').textContent = `${pending ? 'Ждёт ответа' : 'На контроле'} · ${activity}${firstResponse ? ` · ответ ${fmtTime(parseServerDate(firstResponse.created_at))}` : ''}`;
  const btn = $('cv-toggle');
  btn.disabled = legacyDeleted || t.status !== 'open';
  btn.className = t.status === 'open' ? 'danger' : 'okbtn';
  btn.textContent = t.status === 'open' ? 'Закрыть' : (legacyDeleted ? 'Тема удалена' : 'Тикет закрыт');
  const mobileBtn = $('mobile-ticket-toggle');
  mobileBtn.disabled = legacyDeleted || t.status !== 'open';
  mobileBtn.className = `mobile-ticket-toggle ${t.status === 'open' ? 'danger' : 'okbtn'}`;
  mobileBtn.textContent = t.status === 'open' ? 'Закрыть' : (legacyDeleted ? 'Недоступно' : 'Закрыт');
  $('composer').innerHTML = t.status === 'open'
    ? composerHtml()
    : '<div class="closed-note">Тикет закрыт. Для нового обращения создайте новый тикет.</div>';
  if (t.status === 'open') wireComposer();
}
function composerHtml() { return `<div id="admin-file-preview" class="admin-file-preview" style="display:none"></div><div class="compose-row"><button id="quick" class="quick" title="Шаблоны" aria-label="Шаблоны ответов"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg></button><button id="reply-attach" class="quick" title="Прикрепить файл" aria-label="Прикрепить файл"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button><input id="reply-file" type="file" accept="image/*,video/*,audio/*,.jpg,.jpeg,.jpe,.jfif,.heic,.heif,.heics,.heifs,.dng,.avif,.tif,.tiff,.pdf,.doc,.docx,.zip,.txt,.csv,.xls,.xlsx,.pptx,.7z,.rar" style="display:none"><textarea id="reply-txt" rows="1" placeholder="Сообщение" aria-label="Ответ клиенту"></textarea><button id="reply-send" class="send" disabled aria-label="Отправить"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 11.2 20.2 4a.8.8 0 0 1 1 1l-7.1 16.1a.8.8 0 0 1-1.5-.1l-2.2-6.5-6.7-1.8a.8.8 0 0 1-.3-1.5Z"/><path d="m10.4 14.5 4-4" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button></div><div class="hint"><span>Ctrl+Enter — отправить</span><span id="reply-cnt"></span></div>`; }
function wireComposer() { S.file = null; S.uploading = false; $('reply-txt').addEventListener('input', onReplyInput); $('reply-txt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } }); $('reply-send').addEventListener('click', sendReply); $('quick').addEventListener('click', showTemplatePicker); $('reply-attach').addEventListener('click', () => $('reply-file').click()); $('reply-file').addEventListener('change', () => { if ($('reply-file').files[0]) setReplyFile($('reply-file').files[0]); $('reply-file').value = ''; }); }
function renderConversation() { const box = $('cv-msgs'); box.innerHTML = ''; S.lastDate = ''; if (!S.messages.length) { box.innerHTML = '<div class="empty">Сообщений пока нет</div>'; return; } S.messages.forEach(m => appendMessage(m, false)); scrollBottom(false); }
function appendMessage(msg, scroll = false) { const box = $('cv-msgs'); if (!box) return; box.querySelector('.empty')?.remove(); if (msg.sender !== 'system') { const ds = fmtDate(parseServerDate(msg.created_at)); if (ds !== S.lastDate) { S.lastDate = ds; box.insertAdjacentHTML('beforeend', `<div class="day">${esc(ds)}</div>`); } } const out = msg.sender === 'support'; const sys = msg.sender === 'system'; const sender = !out && !sys ? `<div class="sender">${esc(msg.sender_name || 'Клиент')}</div>` : ''; box.insertAdjacentHTML('beforeend', `<div class="msg ${sys ? 'sys' : out ? 'out' : 'in'}"><div class="bubble">${sender}${messageBody(msg)}${reactionsHtml(msg)}<div class="meta">${fmtTime(parseServerDate(msg.created_at))}</div></div></div>`); if (scroll) scrollBottom(true); }
function messageBody(msg) { const text = msg.content ? `<div>${linkify(msg.content)}</div>` : ''; if (msg.message_type === 'image' && msg.file_url) return `<img src="${esc(msg.file_url)}" loading="lazy" decoding="async" onerror="adminMediaFailed(this)">${text}`; if (msg.message_type === 'video' && msg.file_url) return `<video src="${esc(msg.file_url)}" controls preload="metadata" playsinline onerror="adminMediaFailed(this)"></video>${text}`; if (msg.message_type === 'audio' && msg.file_url) return `<audio src="${esc(msg.file_url)}" controls></audio>${text}`; if (msg.file_url) return `<a class="file" href="${esc(msg.file_url)}" target="_blank" rel="noopener noreferrer" download="${esc(msg.file_name || 'file')}"><span class="file-ico">↧</span><span>${esc(msg.file_name || 'Файл')}</span></a>${text}`; return text || '<span></span>'; }
function parseReactions(value) { if (!value) return []; if (Array.isArray(value)) return value.filter(Boolean); try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter(Boolean) : []; } catch { return []; } }
function reactionsHtml(msg) { const reactions = parseReactions(msg.reactions); if (!reactions.length) return ''; return `<div class="rxns">${reactions.map(r => `<span>${esc(r)}</span>`).join('')}</div>`; }
function scrollBottom(smooth) {
  const box = $('cv-msgs');
  if (!box) return;
  const scroll = () => box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  requestAnimationFrame(() => requestAnimationFrame(scroll));
  setTimeout(scroll, 180);
}
function onReplyInput() { const txt = $('reply-txt'), send = $('reply-send'), cnt = $('reply-cnt'); if (!txt || !send) return; if (S.pendingReply && S.pendingReply.content !== txt.value.trim()) S.pendingReply = null; txt.style.height = 'auto'; txt.style.height = `${Math.min(txt.scrollHeight, 140)}px`; send.disabled = S.uploading || (!txt.value.trim() && !S.file); if (cnt) cnt.textContent = txt.value ? `${txt.value.length} симв.` : ''; const now = Date.now(); if (S.current?.id && now - S.lastTyping > 1800) { S.lastTyping = now; socket.emit('admin_typing', { ticketId: S.current.id }); } }
async function sendReply() {
  const txt = $('reply-txt');
  if (!txt || !S.current || S.current.status !== 'open' || S.uploading) return;
  const content = txt.value.trim();
  const file = S.file;
  if (!content && !file) return;
  const maxLength = file ? 1000 : 4000;
  if (content.length > maxLength) return toast(`Слишком длинное сообщение — максимум ${maxLength} символов`, 'err');
  if (!socket.connected) return toast('Нет соединения — попробуйте позже', 'err');
  $('reply-send').disabled = true;
  let fileUrl = S.pendingReply?.fileUrl || null, fileName = S.pendingReply?.fileName || null, fileMime = S.pendingReply?.fileMime || null, messageType = S.pendingReply?.messageType || 'text';
  if (file && !S.pendingReply) {
    S.uploading = true;
    renderReplyFilePreview('Загрузка...');
    try {
      const fd = new FormData();
      fd.append('adminToken', S.token);
      fd.append('file', file);
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Ошибка HTTP ${r.status}`);
      fileUrl = d.url; fileName = d.name; fileMime = d.mime; messageType = d.type;
    } catch (error) {
      S.uploading = false;
      toast(error?.message || 'Ошибка загрузки файла', 'err');
      onReplyInput();
      renderReplyFilePreview();
      return;
    }
    S.uploading = false;
  }
  const payload = S.pendingReply || { ticketId: S.current.id, content, fileUrl, fileName, fileMime, messageType, clientMessageId: crypto.randomUUID() };
  S.pendingReply = payload;
  socket.timeout(15000).emit('admin_reply', payload, (timeoutError, ack) => {
    if (timeoutError || ack?.error) {
      const errorText = ack?.error === 'Message too long'
        ? `Слишком длинное сообщение — максимум ${ack.maxLength || 4000} символов`
        : 'Ошибка отправки';
      toast(timeoutError ? 'Нет подтверждения доставки. Повторная отправка не создаст дубль.' : errorText, 'err');
      onReplyInput();
      return;
    }
    S.pendingReply = null;
    txt.value = '';
    txt.style.height = 'auto';
    $('reply-cnt').textContent = '';
    clearReplyFile();
    onReplyInput();
  });
  tgImpact('light');
}
function setReplyFile(file) {
  const maxMb = Number(S.settings?.uploadMaxMb) || 50;
  if (file.size > maxMb * 1024 * 1024) return toast(`Файл слишком большой (макс. ${maxMb} МБ)`, 'err');
  S.pendingReply = null;
  S.file = file;
  renderReplyFilePreview();
  onReplyInput();
}
function clearReplyFile() {
  S.pendingReply = null;
  S.file = null;
  renderReplyFilePreview();
  onReplyInput();
}
function renderReplyFilePreview(statusText) {
  const el = $('admin-file-preview');
  if (!el) return;
  if (!S.file && !statusText) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const name = statusText || S.file?.name || '';
  el.innerHTML = `<span>${esc(name)}</span>${S.file && !statusText ? '<button id="reply-file-remove" type="button">×</button>' : ''}`;
  $('reply-file-remove')?.addEventListener('click', clearReplyFile);
}
function toggleTicketStatus() { if (!S.current || S.current.status !== 'open') return; tgImpact('medium'); socket.emit('admin_close_ticket', { ticketId: S.current.id }); }

function showTemplatePicker(event) { event.stopPropagation(); document.querySelectorAll('.pop').forEach(p => p.remove()); const pop = document.createElement('div'); pop.className = 'pop'; pop.innerHTML = S.templates.map((t, i) => `<button data-i="${i}"><b>${esc(t.label)}</b><span>${esc(t.text)}</span></button>`).join('') || '<div class="empty">Шаблонов нет</div>'; document.body.appendChild(pop); const r = $('quick').getBoundingClientRect(); pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)}px`; pop.style.top = `${Math.max(74, r.top - pop.offsetHeight - 10)}px`; pop.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { const item = S.templates[Number(btn.dataset.i)]; const txt = $('reply-txt'); txt.value = item.text; txt.dispatchEvent(new Event('input')); txt.focus(); pop.remove(); })); }

function input(id, label, value, type = 'text', attrs = '') { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value ?? '')}" ${attrs}></div>`; }
function area(id, label, value, rows = 3) { return `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" rows="${rows}">${esc(value ?? '')}</textarea></div>`; }
function check(id, label, value) { return `<label class="check setting-toggle"><input id="${id}" type="checkbox" ${value ? 'checked' : ''}><span>${label}</span></label>`; }
function select(id, label, value, options) { return `<div class="field"><label>${label}</label><select id="${id}">${options.map(opt => `<option value="${esc(opt.value)}" ${opt.value === value ? 'selected' : ''}>${esc(opt.label)}</option>`).join('')}</select></div>`; }
function settingCard(category, title, description, content, accent = 'blue', keywords = '') {
  return `<section class="card settings-card" data-settings-category="${esc(category)}" data-settings-keywords="${esc(keywords)}">
    <header class="settings-card-head"><span class="settings-card-mark ${accent}"></span><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div></header>
    <div class="settings-card-body">${content}</div>
  </section>`;
}
function operatorSettingsCard() {
  const rows = S.operators.length
    ? S.operators.map(operator => `<div class="operator-row" data-operator-id="${esc(operator.telegramUserId)}">
        <div class="operator-row-head"><b>${esc(operator.displayName)}</b><span>${operator.active ? 'Активен' : 'Отключён'} · ID ${esc(operator.telegramUserId)}</span></div>
        <div class="operator-row-fields">
          <input data-operator-name value="${esc(operator.displayName)}" aria-label="Имя оператора">
          <input data-operator-username value="${esc(operator.username || '')}" placeholder="username (необязательно)" aria-label="Username Telegram">
        </div>
        <div class="operator-row-access">
          <label><input data-operator-active type="checkbox" ${operator.active ? 'checked' : ''}> Принимает тикеты</label>
          <label><input data-operator-settings type="checkbox" ${operator.canManageSettings ? 'checked' : ''}> Может менять настройки</label>
          <button type="button" class="ghost" data-operator-save>Сохранить</button>
        </div>
      </div>`).join('')
    : '<div class="settings-note">Операторов пока нет. Добавьте Telegram ID ниже.</div>';
  return settingCard(
    'operators',
    'Операторы и права доступа',
    'Добавьте сотрудника по Telegram ID и отдельно разрешите ему доступ к настройкам.',
    '<p class="settings-note">Оператору достаточно открыть бота и нажать /start. Без права на настройки он увидит только рабочий чат.</p>' +
    `<div class="operator-list">${rows}</div>` +
    '<div class="operator-new"><b>Новый оператор</b>' +
    '<div class="operator-row-fields"><input id="operator-new-id" inputmode="numeric" placeholder="Telegram ID"><input id="operator-new-name" placeholder="Имя оператора"><input id="operator-new-username" placeholder="username (необязательно)"></div>' +
    '<div class="operator-row-access"><label><input id="operator-new-active" type="checkbox" checked> Принимает тикеты</label><label><input id="operator-new-settings" type="checkbox"> Может менять настройки</label><button id="operator-new-save" type="button" class="save">Добавить оператора</button></div></div>',
    'violet',
    'оператор доступ права Telegram ID настройки'
  );
}
function val(id) { return $(id)?.value ?? ''; }
function num(id) { return Number(val(id)); }
function checked(id) { return !!$(id)?.checked; }

function renderSettingsLegacy() {
  const s = S.settings || {};
  const topicModeControl = s.telegramMode === 'private'
    ? '<p class="muted">Приватная тема создаётся автоматически после назначения тикета. Для этого у бота должен быть включён Threaded Mode.</p>'
    : check('set-tg-create-topics','Создавать темы тикетов в группе',s.telegramCreateTopics);
  $('settings').innerHTML = `<div class="section"><h2>Настройки проекта</h2><p>Все параметры применяются сразу после сохранения. Переменные .env вроде токена бота и ADMIN_TOKEN остаются на сервере.</p>
  <div class="grid">
    <div class="card"><h3>Чат и график</h3>${input('set-support-name','Имя поддержки в чате',s.supportName || 'Поддержка KV9RU')}${input('set-tz','Часовой пояс',s.timezone || 'Europe/Moscow')}${input('set-work-start','Начало рабочего часа',s.workStartHour ?? 8,'number','min="0" max="23"')}${input('set-work-end','Конец рабочего часа',s.workEndHour ?? 23,'number','min="1" max="24"')}${check('set-offhours-enabled','Показывать предупреждение вне графика',s.offhoursEnabled)}${area('set-banner-text','Баннер перед вводом имени вне графика',s.offhoursBannerText || '')}${area('set-reject-text','Резервный текст предупреждения вне графика',s.offhoursRejectText || '')}</div>
    <div class="card"><h3>Приветствия и ожидание</h3>${check('set-welcome-enabled','Включить цепочку приветствий',s.welcomeEnabled)}${check('set-welcome-1-enabled','Отправлять первое приветствие',s.welcomeText1Enabled ?? true)}${input('set-welcome-delay-1','Задержка первого приветствия, мс',s.welcomeDelayFirstMs ?? 1200,'number','min="0" max="30000"')}${area('set-welcome-1','Первое приветствие',s.welcomeText1 || '',3)}${check('set-welcome-2-enabled','Отправлять второе приветствие',s.welcomeText2Enabled ?? true)}${input('set-welcome-delay-2','Задержка второго приветствия, мс',s.welcomeDelaySecondMs ?? 2800,'number','min="0" max="60000"')}${area('set-welcome-2','Второе приветствие',s.welcomeText2 || '',4)}${check('set-welcome-3-enabled','Отправлять третье дополнительное сообщение',s.welcomeText3Enabled)}${input('set-welcome-delay-3','Задержка третьего сообщения, мс',s.welcomeDelayThirdMs ?? 6500,'number','min="0" max="120000"')}${area('set-welcome-3','Третье дополнительное сообщение',s.welcomeText3 || '',4)}${check('set-operator-wait-enabled','Сообщать клиенту, если оператор задерживается',s.operatorWaitEnabled)}${input('set-operator-wait-delay','Задержка сообщения об ожидании, мс',s.operatorWaitDelayMs ?? 180000,'number','min="10000" max="3600000"')}${area('set-operator-wait-text','Сообщение при долгом ожидании оператора',s.operatorWaitText || '',4)}${input('set-rate','Лимит сообщений в минуту',s.messageRateLimitPerMinute ?? 20,'number','min="1" max="300"')}${input('set-upload','Максимальный файл, МБ',s.uploadMaxMb ?? 50,'number','min="1" max="50"')}</div>
    <div class="card"><h3>Автозакрытие</h3>${check('set-inactivity-enabled','Включить предупреждение и автозакрытие',s.inactivityEnabled)}${input('set-inactivity-warn','Предупредить через, минут',s.inactivityWarnMinutes ?? 45,'number','min="1" max="1440"')}${input('set-inactivity-close','Закрыть через, минут',s.inactivityCloseMinutes ?? 60,'number','min="2" max="2880"')}${area('set-inactivity-warning','Сообщение-предупреждение в чат',s.inactivityWarningText || '',3)}${area('set-inactivity-close-text','Сообщение автозакрытия в чат',s.inactivityCloseText || '',3)}</div>
    <div class="card"><h3>Надёжность и хранение</h3><p class="muted">Параметры применяются без перезапуска. Путь к отдельному хранилищу резервных копий задаётся на сервере.</p>${check('set-backup-enabled','Автоматически создавать резервные копии',s.backupEnabled ?? true)}${input('set-backup-interval','Интервал резервного копирования, часов',s.backupIntervalHours ?? 24,'number','min="1" max="720"')}${input('set-backup-retention','Количество копий базы',s.backupRetention ?? 7,'number','min="1" max="365"')}${check('set-backup-uploads','Копировать загруженные файлы',s.backupUploadsEnabled ?? true)}${check('set-upload-cleanup','Автоматически очищать осиротевшие файлы',s.uploadCleanupEnabled ?? true)}${input('set-upload-cleanup-interval','Проверять файлы каждые, часов',s.uploadCleanupIntervalHours ?? 6,'number','min="1" max="720"')}${input('set-upload-orphan-grace','Не удалять новые файлы в течение, часов',s.uploadOrphanGraceHours ?? 24,'number','min="1" max="8760"')}${check('set-disk-monitoring','Следить за заполнением диска',s.diskMonitoringEnabled ?? true)}${input('set-disk-warning','Предупреждать при заполнении, %',s.diskWarnPercent ?? 75,'number','min="1" max="98"')}${input('set-disk-critical','Критический уровень, %',s.diskCriticalPercent ?? 90,'number','min="2" max="100"')}${check('set-operational-alerts','Присылать системные уведомления об ошибках',s.operationalAlertsEnabled ?? true)}${input('set-operational-alert-cooldown','Не повторять одинаковое уведомление, минут',s.operationalAlertCooldownMinutes ?? 15,'number','min="1" max="1440"')}</div>
    <div class="card"><h3>Telegram: личный бот</h3><p class="muted">Режим: ${esc(s.telegramMode === 'private' ? 'личные чаты операторов' : 'совместимость с группой')}. Если зарегистрирован один активный оператор, новые тикеты назначаются ему автоматически.</p>${check('set-tg-enabled','Включить Telegram-интеграцию',s.telegramEnabled)}${topicModeControl}${check('set-tg-forward-user','Пересылать сообщения клиента оператору',s.telegramForwardUserMessages)}${check('set-tg-forward-admin','Показывать ответы из админки в теме',s.telegramForwardAdminMessages)}${check('set-tg-forward-operator','Принимать ответы оператора из Telegram',s.telegramForwardOperatorMessages)}${check('set-tg-reminders','Напоминать со звуком, пока оператор не ответил',s.telegramUnansweredReminderEnabled ?? true)}${input('set-tg-reminder-first','Первое напоминание через, минут',s.telegramUnansweredReminderMinutes ?? 3,'number','min="1" max="1440"')}${input('set-tg-reminder-repeat','Повторять напоминание каждые, минут',s.telegramUnansweredRepeatMinutes ?? 5,'number','min="1" max="1440"')}${check('set-tg-delete-renames','Удалять сервисные сообщения Telegram',s.telegramDeleteRenameNotices)}${check('set-tg-pin','Закреплять rich-карточку тикета',s.telegramPinNewTicketMessage)}${check('set-tg-close-topic','Закрывать приватную тему вместе с тикетом',s.telegramCloseTopicOnClose)}${check('set-tg-cleanup','Удалять старые закрытые темы',s.telegramCleanupClosedTopics)}${input('set-tg-cleanup-hours','Удалять закрытые темы через, часов (0 — сразу)',s.telegramCleanupClosedHours ?? 24,'number','min="0" max="720"')}</div>
    <div class="card"><h3>Telegram: приватные темы и кнопки</h3>${input('set-topic-template','Шаблон названия темы',s.telegramTopicNameTemplate || '{emoji} {name} • {date}')}${input('set-emoji-new','Эмодзи нового тикета',s.telegramNewEmoji || '❗')}${input('set-emoji-open','Эмодзи в работе',s.telegramOpenEmoji || '🔵')}${input('set-emoji-wait','Эмодзи ждет ответа',s.telegramWaitEmoji || '🔔')}${input('set-emoji-closed','Эмодзи закрыто',s.telegramClosedEmoji || '🗑️')}${input('set-close-btn','Текст кнопки закрытия',s.telegramCloseButtonText || '🗑️ Закрыть тикет')}${select('set-close-btn-style','Цвет кнопки закрытия',s.telegramCloseButtonStyle || 'danger',[{value:'danger',label:'Красная'},{value:'success',label:'Зеленая'},{value:'primary',label:'Синяя'},{value:'',label:'Стандартная'}])}${input('set-close-btn-emoji-id','ID анимированного emoji закрытия',s.telegramCloseButtonEmojiId || '')}</div>
    <div class="card"><h3>Telegram: тексты</h3>${area('set-tg-new-ticket','Карточка нового тикета (legacy)',s.telegramNewTicketText || '',5)}${area('set-tg-closed-user','Закрыто пользователем',s.telegramClosedByUserText || '',2)}${area('set-tg-closed-support','Закрыто оператором',s.telegramClosedBySupportText || '',2)}${area('set-tg-autoclose','Автозакрытие в Telegram',s.telegramAutoCloseText || '',3)}${area('set-tg-warn','Предупреждение о неактивности в Telegram',s.telegramWarnInactivityText || '',3)}${area('set-tg-topic-deleted','Ошибка удаленной темы в админке (legacy)',s.telegramTopicDeletedAdminText || '',2)}</div>
  </div><p style="margin-top:14px">Переменные для шаблонов: {name}, {shortId}, {date}, {dateTime}, {emoji}, {minutes}, {warnMinutes}, {remainingMinutes}.</p><button id="set-save" class="save">Сохранить все настройки</button></div>`;
  $('set-save').addEventListener('click', saveSettings);
}

function saveSettingsLegacy() {
  const payload = {
    supportName: val('set-support-name'), timezone: val('set-tz'), workStartHour: num('set-work-start'), workEndHour: num('set-work-end'), offhoursEnabled: checked('set-offhours-enabled'), offhoursBannerText: val('set-banner-text'), offhoursRejectText: val('set-reject-text'),
    welcomeEnabled: checked('set-welcome-enabled'), welcomeText1Enabled: checked('set-welcome-1-enabled'), welcomeText2Enabled: checked('set-welcome-2-enabled'), welcomeText3Enabled: checked('set-welcome-3-enabled'), welcomeDelayFirstMs: num('set-welcome-delay-1'), welcomeDelaySecondMs: num('set-welcome-delay-2'), welcomeDelayThirdMs: num('set-welcome-delay-3'), welcomeText1: val('set-welcome-1'), welcomeText2: val('set-welcome-2'), welcomeText3: val('set-welcome-3'), operatorWaitEnabled: checked('set-operator-wait-enabled'), operatorWaitDelayMs: num('set-operator-wait-delay'), operatorWaitText: val('set-operator-wait-text'), messageRateLimitPerMinute: num('set-rate'), uploadMaxMb: num('set-upload'),
    inactivityEnabled: checked('set-inactivity-enabled'), inactivityWarnMinutes: num('set-inactivity-warn'), inactivityCloseMinutes: num('set-inactivity-close'), inactivityWarningText: val('set-inactivity-warning'), inactivityCloseText: val('set-inactivity-close-text'),
    backupEnabled: checked('set-backup-enabled'), backupIntervalHours: num('set-backup-interval'), backupRetention: num('set-backup-retention'), backupUploadsEnabled: checked('set-backup-uploads'), uploadCleanupEnabled: checked('set-upload-cleanup'), uploadCleanupIntervalHours: num('set-upload-cleanup-interval'), uploadOrphanGraceHours: num('set-upload-orphan-grace'), diskMonitoringEnabled: checked('set-disk-monitoring'), diskWarnPercent: num('set-disk-warning'), diskCriticalPercent: num('set-disk-critical'), operationalAlertsEnabled: checked('set-operational-alerts'), operationalAlertCooldownMinutes: num('set-operational-alert-cooldown'),
    telegramEnabled: checked('set-tg-enabled'), telegramCreateTopics: S.settings?.telegramMode === 'private' ? true : checked('set-tg-create-topics'), telegramAutoAssignSingleOperator: true, telegramForwardUserMessages: checked('set-tg-forward-user'), telegramForwardAdminMessages: checked('set-tg-forward-admin'), telegramForwardOperatorMessages: checked('set-tg-forward-operator'), telegramUnansweredReminderEnabled: checked('set-tg-reminders'), telegramUnansweredReminderMinutes: num('set-tg-reminder-first'), telegramUnansweredRepeatMinutes: num('set-tg-reminder-repeat'), telegramDeleteRenameNotices: checked('set-tg-delete-renames'), telegramPinNewTicketMessage: checked('set-tg-pin'), telegramCloseTopicOnClose: checked('set-tg-close-topic'), telegramCleanupClosedTopics: checked('set-tg-cleanup'), telegramCleanupClosedHours: num('set-tg-cleanup-hours'),
    telegramTopicNameTemplate: val('set-topic-template'), telegramNewEmoji: val('set-emoji-new'), telegramOpenEmoji: val('set-emoji-open'), telegramWaitEmoji: val('set-emoji-wait'), telegramClosedEmoji: val('set-emoji-closed'), telegramCloseButtonText: val('set-close-btn'), telegramCloseButtonStyle: val('set-close-btn-style'), telegramCloseButtonEmojiId: val('set-close-btn-emoji-id'),
    telegramNewTicketText: val('set-tg-new-ticket'), telegramClosedByUserText: val('set-tg-closed-user'), telegramClosedBySupportText: val('set-tg-closed-support'), telegramAutoCloseText: val('set-tg-autoclose'), telegramWarnInactivityText: val('set-tg-warn'), telegramTopicDeletedAdminText: val('set-tg-topic-deleted')
  };
  socket.emit('admin_update_settings', payload);
  toast('Настройки сохранены', 'ok');
}

function richSettingsSection(title, description, body, open = true) {
  return `<details class="rich-settings-section" ${open ? 'open' : ''}><summary><span>${esc(title)}</span><small>${esc(description)}</small></summary><div class="rich-settings-section-body">${body}</div></details>`;
}

function richPresetControls() {
  return `<div class="rich-preset-row"><button type="button" data-rich-preset="balanced">Сбалансированный</button><button type="button" data-rich-preset="compact">Компактный</button><button type="button" data-rich-preset="dialog">Диалог</button><button type="button" data-rich-preset="journal">Журнал</button><button type="button" data-rich-preset="minimal">Минимальный</button></div><div id="rich-transcript-preview" class="rich-transcript-preview"></div>`;
}

function renderRichTranscriptPreview() {
  const preview = $('rich-transcript-preview');
  if (!preview) return;
  const replace = (value, name, role) => String(value || '').replace(/\{name\}/g, name).replace(/\{role\}/g, role);
  const user = replace(val('set-tg-rich-user-label') || '👤 {name}', 'Алексей', 'Клиент');
  const operator = replace(val('set-tg-rich-operator-label') || '🛟 {name}', 'Владислав', 'Оператор');
  const grouped = val('set-tg-rich-author-mode') === 'grouped';
  const time = checked('set-tg-rich-time');
  const continuation = val('set-tg-rich-group-continuation') === 'time' && time ? '15:45 · ' : '';
  const title = replace(val('set-tg-rich-title') || '💬 Диалог · {name}', 'Алексей', 'Клиент');
  preview.innerHTML = `<div class="rich-preview-head"><span>Предпросмотр</span><b>${esc(title)}</b></div><div class="rich-preview-line"><strong>${esc(user)}</strong>${time ? ' · <i>15:44</i>' : ''}<em>Скриншот не подключается</em></div><div class="rich-preview-line">${grouped ? '' : `<strong>${esc(user)}</strong>${time ? ' · <i>15:45</i>' : ''}`}<em>${continuation}Отправляю ещё раз</em></div><div class="rich-preview-line"><strong>${esc(operator)}</strong>${time ? ' · <i>15:46</i>' : ''}<em>Проверяем</em></div>`;
}

function applyRichPreset(name) {
  const presets = {
    balanced: { 'set-tg-rich-title-size':'medium', 'set-tg-rich-title-style':'bold', 'set-tg-rich-layout':'plain', 'set-tg-rich-message-size':'normal', 'set-tg-rich-author-mode':'grouped', 'set-tg-rich-group-window':'10', 'set-tg-rich-group-continuation':'time', 'set-tg-rich-group-spacing':'compact', 'set-tg-rich-time-format':'time', 'set-tg-rich-separator':'space', 'set-tg-rich-density':'normal', 'set-tg-rich-max-messages':'8', 'set-tg-rich-max-chars':'360' },
    compact: { 'set-tg-rich-title-size':'small', 'set-tg-rich-title-style':'bold', 'set-tg-rich-layout':'compact', 'set-tg-rich-message-size':'compact', 'set-tg-rich-author-mode':'grouped', 'set-tg-rich-group-window':'20', 'set-tg-rich-group-continuation':'time', 'set-tg-rich-group-spacing':'compact', 'set-tg-rich-time-format':'time', 'set-tg-rich-separator':'space', 'set-tg-rich-density':'compact', 'set-tg-rich-max-messages':'14', 'set-tg-rich-max-chars':'220' },
    dialog: { 'set-tg-rich-title-size':'medium', 'set-tg-rich-title-style':'bold', 'set-tg-rich-layout':'quote', 'set-tg-rich-message-size':'normal', 'set-tg-rich-author-mode':'grouped', 'set-tg-rich-group-window':'7', 'set-tg-rich-group-continuation':'time', 'set-tg-rich-group-spacing':'inherit', 'set-tg-rich-time-format':'time', 'set-tg-rich-separator':'space', 'set-tg-rich-density':'normal', 'set-tg-rich-max-messages':'10', 'set-tg-rich-max-chars':'420' },
    journal: { 'set-tg-rich-title-size':'large', 'set-tg-rich-title-style':'plain', 'set-tg-rich-layout':'quote', 'set-tg-rich-message-size':'normal', 'set-tg-rich-author-mode':'every', 'set-tg-rich-group-window':'0', 'set-tg-rich-group-continuation':'time', 'set-tg-rich-group-spacing':'inherit', 'set-tg-rich-time-format':'date_time', 'set-tg-rich-separator':'line', 'set-tg-rich-density':'airy', 'set-tg-rich-max-messages':'10', 'set-tg-rich-max-chars':'500' },
    minimal: { 'set-tg-rich-title-size':'small', 'set-tg-rich-title-style':'plain', 'set-tg-rich-layout':'compact', 'set-tg-rich-message-size':'compact', 'set-tg-rich-author-mode':'hidden', 'set-tg-rich-group-window':'0', 'set-tg-rich-group-continuation':'text', 'set-tg-rich-group-spacing':'compact', 'set-tg-rich-time-format':'time', 'set-tg-rich-separator':'space', 'set-tg-rich-density':'compact', 'set-tg-rich-max-messages':'16', 'set-tg-rich-max-chars':'180', 'set-tg-rich-show-subtitle':false, 'set-tg-rich-author':false, 'set-tg-rich-time':true }
  };
  for (const [id, value] of Object.entries(presets[name] || {})) {
    const control = $(id);
    if (control) {
      if (control.type === 'checkbox') control.checked = Boolean(value);
      else control.value = value;
    }
  }
  renderRichTranscriptPreview();
  updateSettingsDirtyState();
}

function settingsCards(s, topicModeControl) {
  return [
    operatorSettingsCard(),
    settingCard(
      'general',
      'Чат и график',
      'Имя поддержки, рабочее время и сообщения вне графика.',
      input('set-support-name','Имя поддержки в чате',s.supportName || 'Поддержка KV9RU') +
      input('set-tz','Часовой пояс',s.timezone || 'Europe/Moscow') +
      input('set-work-start','Начало рабочего часа',s.workStartHour ?? 8,'number','min="0" max="23"') +
      input('set-work-end','Конец рабочего часа',s.workEndHour ?? 23,'number','min="1" max="24"') +
      check('set-offhours-enabled','Показывать предупреждение вне графика',s.offhoursEnabled) +
      area('set-banner-text','Баннер перед вводом имени вне графика',s.offhoursBannerText || '') +
      area('set-reject-text','Резервный текст предупреждения вне графика',s.offhoursRejectText || ''),
      'blue',
      'расписание время имя баннер'
    ),
    settingCard(
      'automation',
      'Приветствия и ожидание',
      'Автоматические сообщения клиенту, ограничения и загрузки.',
      check('set-welcome-enabled','Включить цепочку приветствий',s.welcomeEnabled) +
      check('set-welcome-1-enabled','Отправлять первое приветствие',s.welcomeText1Enabled ?? true) +
      input('set-welcome-delay-1','Задержка первого приветствия, мс',s.welcomeDelayFirstMs ?? 1200,'number','min="0" max="30000"') +
      area('set-welcome-1','Первое приветствие',s.welcomeText1 || '',3) +
      check('set-welcome-2-enabled','Отправлять второе приветствие',s.welcomeText2Enabled ?? true) +
      input('set-welcome-delay-2','Задержка второго приветствия, мс',s.welcomeDelaySecondMs ?? 2800,'number','min="0" max="60000"') +
      area('set-welcome-2','Второе приветствие',s.welcomeText2 || '',4) +
      check('set-welcome-3-enabled','Отправлять третье дополнительное сообщение',s.welcomeText3Enabled) +
      input('set-welcome-delay-3','Задержка третьего сообщения, мс',s.welcomeDelayThirdMs ?? 6500,'number','min="0" max="120000"') +
      area('set-welcome-3','Третье дополнительное сообщение',s.welcomeText3 || '',4) +
      check('set-operator-wait-enabled','Сообщать клиенту, если оператор задерживается',s.operatorWaitEnabled) +
      input('set-operator-wait-delay','Задержка сообщения об ожидании, мс',s.operatorWaitDelayMs ?? 180000,'number','min="10000" max="3600000"') +
      area('set-operator-wait-text','Сообщение при долгом ожидании оператора',s.operatorWaitText || '',4) +
      input('set-rate','Лимит сообщений в минуту',s.messageRateLimitPerMinute ?? 20,'number','min="1" max="300"') +
      input('set-upload','Максимальный файл, МБ',s.uploadMaxMb ?? 50,'number','min="1" max="50"'),
      'violet',
      'приветствие ожидание лимит файл'
    ),
    settingCard(
      'automation',
      'Автозакрытие',
      'Предупреждение и завершение неактивных тикетов.',
      check('set-inactivity-enabled','Включить предупреждение и автозакрытие',s.inactivityEnabled) +
      input('set-inactivity-warn','Предупредить через, минут',s.inactivityWarnMinutes ?? 45,'number','min="1" max="1440"') +
      input('set-inactivity-close','Закрыть через, минут',s.inactivityCloseMinutes ?? 60,'number','min="2" max="2880"') +
      area('set-inactivity-warning','Сообщение-предупреждение в чат',s.inactivityWarningText || '',3) +
      area('set-inactivity-close-text','Сообщение автозакрытия в чат',s.inactivityCloseText || '',3),
      'amber',
      'закрытие неактивность таймер'
    ),
    settingCard(
      'system',
      'Надёжность и хранение',
      'Резервные копии, очистка, диск и системные сигналы.',
      check('set-backup-enabled','Автоматически создавать резервные копии',s.backupEnabled ?? true) +
      input('set-backup-interval','Интервал резервного копирования, часов',s.backupIntervalHours ?? 24,'number','min="1" max="720"') +
      input('set-backup-retention','Количество копий базы',s.backupRetention ?? 7,'number','min="1" max="365"') +
      check('set-backup-uploads','Копировать загруженные файлы',s.backupUploadsEnabled ?? true) +
      check('set-upload-cleanup','Автоматически очищать осиротевшие файлы',s.uploadCleanupEnabled ?? true) +
      input('set-upload-cleanup-interval','Проверять файлы каждые, часов',s.uploadCleanupIntervalHours ?? 6,'number','min="1" max="720"') +
      input('set-upload-orphan-grace','Не удалять новые файлы в течение, часов',s.uploadOrphanGraceHours ?? 24,'number','min="1" max="8760"') +
      check('set-disk-monitoring','Следить за заполнением диска',s.diskMonitoringEnabled ?? true) +
      input('set-disk-warning','Предупреждать при заполнении, %',s.diskWarnPercent ?? 75,'number','min="1" max="98"') +
      input('set-disk-critical','Критический уровень, %',s.diskCriticalPercent ?? 90,'number','min="2" max="100"') +
      check('set-operational-alerts','Присылать системные уведомления об ошибках',s.operationalAlertsEnabled ?? true) +
      input('set-operational-alert-cooldown','Не повторять одинаковое уведомление, минут',s.operationalAlertCooldownMinutes ?? 15,'number','min="1" max="1440"'),
      'green',
      'backup резерв диск очистка уведомления'
    ),
    settingCard(
      'telegram',
      'Telegram для клиентов',
      `Приём тикетов, файлов и доставка ответов через этого же бота${s.telegramMode === 'private' ? '.' : ' (доступно после перехода в private-режим).'}`,
      check('set-tg-customer-enabled','Разрешить клиентам писать боту',s.telegramCustomerEnabled ?? true) +
      check('set-tg-customer-files','Принимать фото, видео и файлы',s.telegramCustomerFilesEnabled ?? true) +
      check('set-tg-customer-replies','Доставлять ответы поддержки в Telegram',s.telegramCustomerDeliverReplies ?? true) +
      '<div class="settings-note">Команда /start сразу создаёт тикет. После закрытия бот очищает диалог и оставляет одну Rich-карточку создания нового тикета. Приветствия и ожидание берутся из общей карточки «Приветствия и ожидание».</div>' +
      area('set-tg-customer-new','Rich-карточка открытого тикета',s.telegramCustomerNewTicketText || '',5) +
      area('set-tg-customer-closed','Rich-карточка после закрытия',s.telegramCustomerClosedText || '',5) +
      area('set-tg-customer-closed-user','Причина: закрыл клиент',s.telegramCustomerClosedByUserText || '',2) +
      area('set-tg-customer-closed-support','Причина: закрыл оператор',s.telegramCustomerClosedBySupportText || '',2) +
      area('set-tg-customer-closed-system','Причина: закрыло автозакрытие',s.telegramCustomerClosedBySystemText || '',2) +
      area('set-tg-customer-close-prompt','Текст перед кнопкой закрытия',s.telegramCustomerClosePromptText || '',3) +
      input('set-tg-customer-close-btn','Кнопка закрытия тикета у клиента',s.telegramCustomerCloseButtonText || '✅ Закрыть тикет') +
      input('set-tg-customer-new-btn','Кнопка создания нового тикета',s.telegramCustomerNewButtonText || '🆕 Создать новый тикет') +
      input('set-tg-customer-send-close-btn','Кнопка оператора для отправки закрытия',s.telegramCustomerSendCloseButtonText || '📨 Отправить кнопку закрытия'),
      'blue',
      'клиент бот личные сообщения профиль rich кнопки закрытие'
    ),
    settingCard(
      'telegram',
      'Telegram для операторов',
      `Режим: ${s.telegramMode === 'private' ? 'личные чаты операторов' : 'совместимость с группой'}. Один оператор назначается автоматически.`,
      check('set-tg-enabled','Включить Telegram-интеграцию',s.telegramEnabled) +
      topicModeControl +
      check('set-tg-auto-assign','Автоматически назначать, если оператор один',s.telegramAutoAssignSingleOperator ?? true) +
      check('set-tg-forward-user','Пересылать сообщения клиента оператору',s.telegramForwardUserMessages) +
      check('set-tg-forward-admin','Показывать ответы из админки в теме',s.telegramForwardAdminMessages) +
      check('set-tg-forward-operator','Принимать ответы оператора из Telegram',s.telegramForwardOperatorMessages) +
      check('set-tg-reminders','Напоминать со звуком, пока оператор не ответил',s.telegramUnansweredReminderEnabled ?? true) +
      input('set-tg-reminder-first','Первое напоминание через, минут',s.telegramUnansweredReminderMinutes ?? 3,'number','min="1" max="1440"') +
      input('set-tg-reminder-repeat','Повторять напоминание каждые, минут',s.telegramUnansweredRepeatMinutes ?? 5,'number','min="1" max="1440"') +
      check('set-tg-delete-renames','Удалять сервисные сообщения Telegram',s.telegramDeleteRenameNotices) +
      check('set-tg-pin','Закреплять rich-карточку тикета',s.telegramPinNewTicketMessage) +
      check('set-tg-close-topic','Закрывать приватную тему вместе с тикетом',s.telegramCloseTopicOnClose) +
      check('set-tg-cleanup','Удалять старые закрытые темы',s.telegramCleanupClosedTopics) +
      input('set-tg-cleanup-hours','Удалять закрытые темы через, часов (0 — сразу)',s.telegramCleanupClosedHours ?? 24,'number','min="0" max="720"'),
      'blue',
      'оператор очередь тема напоминание'
    ),
    settingCard(
      'telegram',
      'Темы и кнопки',
      'Названия, статусы и внешний вид действий в Telegram.',
      input('set-topic-template','Шаблон названия темы',s.telegramTopicNameTemplate || '{emoji} {name} • {date}') +
      input('set-emoji-new','Эмодзи нового тикета',s.telegramNewEmoji || '❗') +
      input('set-emoji-open','Эмодзи в работе',s.telegramOpenEmoji || '🔵') +
      input('set-emoji-wait','Эмодзи ждёт ответа',s.telegramWaitEmoji || '🔔') +
      input('set-emoji-closed','Эмодзи закрыто',s.telegramClosedEmoji || '🗑️') +
      input('set-close-btn','Текст кнопки закрытия',s.telegramCloseButtonText || '🗑️ Закрыть тикет') +
      select('set-close-btn-style','Цвет кнопки закрытия',s.telegramCloseButtonStyle || 'danger',[{value:'danger',label:'Красная'},{value:'success',label:'Зелёная'},{value:'primary',label:'Синяя'},{value:'',label:'Стандартная'}]) +
      input('set-close-btn-emoji-id','ID анимированного emoji закрытия',s.telegramCloseButtonEmojiId || ''),
      'violet',
      'название темы emoji кнопка цвет'
    ),
    settingCard(
      'telegram',
      'Rich-диалог оператора',
      'Конструктор единого сообщения с историей тикета. После сохранения открытые тикеты перерисуются автоматически. Цвета и произвольные px Telegram не позволяет задавать ботам, остальные поддерживаемые стили доступны ниже.',
      richSettingsSection('Быстрый старт', 'Выберите основу и сразу посмотрите результат.', richPresetControls() + '<div class="settings-note">Шаблоны: {name}, {shortId}, {status}, {total}, {shown}, {hidden}. В подписях доступны {name} и {role}.</div>') +
      richSettingsSection('Появление карточки', 'Нативный эффект Telegram для нового диалога: не влияет на доставку сообщений.',
      select('set-tg-rich-entry-effect','Эффект появления',s.telegramRichTranscriptEntryEffect || 'off',[
        {value:'off',label:'Сразу, без эффекта (рекомендуется)'}, {value:'draft',label:'Мягкое появление текста'}
      ]) +
      input('set-tg-rich-entry-effect-delay','Скорость эффекта, мс',s.telegramRichTranscriptEntryEffectDelayMs ?? 180,'number','min="0" max="1200" step="20"') +
      input('set-tg-rich-entry-effect-text','Текст в момент появления',s.telegramRichTranscriptEntryEffectText || 'Собираем диалог…') +
      '<div class="settings-note">Эффект работает только там, где Telegram поддерживает Rich-черновики. При отсутствии поддержки карточка сразу отправляется обычным надёжным способом.</div>', false) +
      richSettingsSection('Шапка диалога', 'Название, статус и масштаб верхней части карточки.',
      input('set-tg-rich-title','Заголовок',s.telegramRichTranscriptTitle || '💬 Диалог · {name}') +
      input('set-tg-rich-subtitle','Подзаголовок',s.telegramRichTranscriptSubtitle ?? 'Тикет {shortId} · {status}') +
      check('set-tg-rich-show-header','Показывать заголовок',s.telegramRichTranscriptShowHeader ?? true) +
      check('set-tg-rich-show-subtitle','Показывать подзаголовок',s.telegramRichTranscriptShowSubtitle ?? true) +
      select('set-tg-rich-title-size','Размер заголовка',s.telegramRichTranscriptTitleSize || 'medium',[
        {value:'large',label:'Крупный'}, {value:'medium',label:'Средний'}, {value:'small',label:'Малый'}, {value:'compact',label:'Компактный'}
      ]) +
      select('set-tg-rich-title-style','Начертание заголовка',s.telegramRichTranscriptTitleStyle || 'bold',[
        {value:'bold',label:'Жирное'}, {value:'plain',label:'Обычное'}, {value:'italic',label:'Курсив'}
      ]) +
      select('set-tg-rich-subtitle-style','Начертание подзаголовка',s.telegramRichTranscriptSubtitleStyle || 'muted',[
        {value:'muted',label:'Приглушённый курсив'}, {value:'plain',label:'Обычное'}, {value:'code',label:'Моноширинное'}
      ])) +
      richSettingsSection('Реплики и история', 'Сколько сообщений попадёт в карточку и как будет выглядеть текст.',
      input('set-tg-rich-max-messages','Сколько последних реплик показывать',s.telegramRichTranscriptMaxMessages ?? 8,'number','min="1" max="30"') +
      input('set-tg-rich-max-chars','Максимум символов в одной реплике',s.telegramRichTranscriptMessageMaxChars ?? 360,'number','min="80" max="700"') +
      select('set-tg-rich-order','Порядок реплик',s.telegramRichTranscriptOrder || 'oldest_first',[
        {value:'oldest_first',label:'Старые сверху, новые снизу'}, {value:'newest_first',label:'Новые сверху, старые снизу'}
      ]) +
      select('set-tg-rich-layout','Вид реплик',s.telegramRichTranscriptMessageLayout || 'plain',[
        {value:'plain',label:'Обычный текст'}, {value:'quote',label:'Цитаты'}, {value:'compact',label:'Компактные строки'}
      ]) +
      select('set-tg-rich-message-size','Масштаб текста реплик',s.telegramRichTranscriptMessageSize || 'normal',[
        {value:'compact',label:'Компактный'}, {value:'normal',label:'Обычный'}, {value:'large',label:'Крупный'}
      ]) +
      select('set-tg-rich-message-header-style','Начертание автора',s.telegramRichTranscriptMessageHeaderStyle || 'bold',[
        {value:'bold',label:'Жирное'}, {value:'plain',label:'Обычное'}, {value:'italic',label:'Курсив'}
      ]), false) +
      richSettingsSection('Имена и группы', 'Уберите повторяющиеся ники: имя останется только в начале серии сообщений.',
      check('set-tg-rich-author','Показывать автора реплики',s.telegramRichTranscriptShowAuthor ?? true) +
      select('set-tg-rich-author-mode','Повтор автора в соседних репликах',s.telegramRichTranscriptAuthorMode || 'grouped',[
        {value:'grouped',label:'Показывать только в начале группы'}, {value:'every',label:'Показывать в каждой реплике'}, {value:'hidden',label:'Не показывать автора'}
      ]) +
      input('set-tg-rich-group-window','Объединять реплики одного автора в пределах, мин.',s.telegramRichTranscriptGroupWindowMinutes ?? 10,'number','min="0" max="120"') +
      select('set-tg-rich-group-continuation','В продолжении группы показывать',s.telegramRichTranscriptGroupContinuation || 'time',[
        {value:'time',label:'Только время'}, {value:'none',label:'Только текст'}
      ]) +
      select('set-tg-rich-group-spacing','Отступы внутри группы',s.telegramRichTranscriptGroupSpacing || 'compact',[
        {value:'compact',label:'Плотно'}, {value:'inherit',label:'Как между всеми репликами'}
      ]) +
      input('set-tg-rich-user-label','Подпись клиента ({name} — имя клиента)',s.telegramRichTranscriptUserLabel || '👤 {name}') +
      input('set-tg-rich-operator-label','Подпись оператора',s.telegramRichTranscriptOperatorLabel || '🛟 {name}')) +
      richSettingsSection('Время и разделители', 'Тонкая настройка плотности, отметок времени и вложений.',
      check('set-tg-rich-time','Показывать время реплики',s.telegramRichTranscriptShowTime ?? true) +
      select('set-tg-rich-time-format','Формат времени',s.telegramRichTranscriptTimestampFormat || 'time',[
        {value:'time',label:'Только время'}, {value:'date_time',label:'Дата и время'}
      ]) +
      check('set-tg-rich-media-label','Подписывать вложения в истории',s.telegramRichTranscriptShowMediaLabel ?? true) +
      check('set-tg-rich-omitted','Показывать число скрытых реплик',s.telegramRichTranscriptShowOmittedNotice ?? true) +
      select('set-tg-rich-separator','Разделять реплики',s.telegramRichTranscriptSeparator || 'space',[
        {value:'space',label:'Свободным отступом'},
        {value:'dots',label:'Строкой с точками'},
        {value:'line',label:'Тонкой линией'}
      ]) +
      select('set-tg-rich-density','Плотность диалога',s.telegramRichTranscriptDensity || 'normal',[
        {value:'compact',label:'Плотно'}, {value:'normal',label:'Обычно'}, {value:'airy',label:'Свободно'}
      ]) +
      input('set-tg-rich-footer','Нижняя подпись (необязательно)',s.telegramRichTranscriptFooter || '') +
      input('set-tg-rich-empty','Текст пустого диалога',s.telegramRichTranscriptEmptyText || 'Пока нет сообщений'), false),
      'blue',
      'rich диалог история реплики текст автор время цитаты размер шрифт подписи footer оформление'
    ),
    settingCard(
      'telegram',
      'Системные тексты Telegram',
      'Сообщения о закрытии и неактивности.',
      area('set-tg-new-ticket','Карточка нового тикета (legacy)',s.telegramNewTicketText || '',5) +
      area('set-tg-closed-user','Закрыто пользователем',s.telegramClosedByUserText || '',2) +
      area('set-tg-closed-support','Закрыто оператором',s.telegramClosedBySupportText || '',2) +
      area('set-tg-autoclose','Автозакрытие в Telegram',s.telegramAutoCloseText || '',3) +
      area('set-tg-warn','Предупреждение о неактивности в Telegram',s.telegramWarnInactivityText || '',3) +
      area('set-tg-topic-deleted','Ошибка удалённой темы в админке (legacy)',s.telegramTopicDeletedAdminText || '',2),
      'amber',
      'текст закрыто открыто неактивность'
    )
  ];
}

function renderSettings() {
  const s = S.settings || {};
  const topicModeControl = s.telegramMode === 'private'
    ? '<div class="settings-note">Приватная тема создаётся автоматически после назначения. У бота должен быть включён Threaded Mode.</div>'
    : check('set-tg-create-topics','Создавать темы тикетов в группе',s.telegramCreateTopics);
  const filters = [['all','Все'],['operators','Операторы'],['general','Основные'],['automation','Автоматизация'],['telegram','Telegram'],['system','Система']];
  $('settings').innerHTML = `<div class="section settings-section">
    <div class="settings-hero">
      <div><span class="settings-eyebrow">Центр управления</span><h2>Настройки проекта</h2><p>Все безопасные параметры собраны здесь и применяются только после подтверждения сервером.</p></div>
      <div class="settings-hero-actions"><button id="settings-export" class="ghost">Экспорт</button><button id="settings-test-alert" class="ghost">Тест уведомления</button></div>
    </div>
    <div class="settings-toolbar">
      <input id="settings-search" type="search" value="${esc(S.settingsQuery)}" placeholder="Найти настройку…" aria-label="Поиск по настройкам">
      <div class="settings-filters">${filters.map(([value,label]) => `<button type="button" data-settings-filter="${value}" class="${S.settingsFilter === value ? 'on' : ''}">${label}</button>`).join('')}</div>
    </div>
    <div id="settings-grid" class="grid settings-grid">${settingsCards(s, topicModeControl).join('')}</div>
    <div id="settings-empty" class="settings-empty">По этому запросу настроек нет.</div>
    <p class="settings-variables">Переменные шаблонов: {name}, {shortId}, {status}, {reason}, {date}, {dateTime}, {emoji}, {minutes}, {warnMinutes}, {remainingMinutes}.</p>
    <div class="settings-savebar">
      <div><b id="settings-save-state">Изменений нет</b><span id="settings-save-time">${S.settingsLastSavedAt ? `Сохранено ${esc(fmtStatusDate(S.settingsLastSavedAt))}` : 'Настройки загружены с сервера'}</span></div>
      <button id="settings-discard" class="ghost" disabled>Отменить</button>
      <button id="set-save" class="save" disabled>Сохранить настройки</button>
    </div>
  </div>`;
  bindSettingsUi();
}

function settingsPayload() {
  return {
    supportName: val('set-support-name'), timezone: val('set-tz'), workStartHour: num('set-work-start'), workEndHour: num('set-work-end'), offhoursEnabled: checked('set-offhours-enabled'), offhoursBannerText: val('set-banner-text'), offhoursRejectText: val('set-reject-text'),
    welcomeEnabled: checked('set-welcome-enabled'), welcomeText1Enabled: checked('set-welcome-1-enabled'), welcomeText2Enabled: checked('set-welcome-2-enabled'), welcomeText3Enabled: checked('set-welcome-3-enabled'), welcomeDelayFirstMs: num('set-welcome-delay-1'), welcomeDelaySecondMs: num('set-welcome-delay-2'), welcomeDelayThirdMs: num('set-welcome-delay-3'), welcomeText1: val('set-welcome-1'), welcomeText2: val('set-welcome-2'), welcomeText3: val('set-welcome-3'), operatorWaitEnabled: checked('set-operator-wait-enabled'), operatorWaitDelayMs: num('set-operator-wait-delay'), operatorWaitText: val('set-operator-wait-text'), messageRateLimitPerMinute: num('set-rate'), uploadMaxMb: num('set-upload'),
    inactivityEnabled: checked('set-inactivity-enabled'), inactivityWarnMinutes: num('set-inactivity-warn'), inactivityCloseMinutes: num('set-inactivity-close'), inactivityWarningText: val('set-inactivity-warning'), inactivityCloseText: val('set-inactivity-close-text'),
    backupEnabled: checked('set-backup-enabled'), backupIntervalHours: num('set-backup-interval'), backupRetention: num('set-backup-retention'), backupUploadsEnabled: checked('set-backup-uploads'), uploadCleanupEnabled: checked('set-upload-cleanup'), uploadCleanupIntervalHours: num('set-upload-cleanup-interval'), uploadOrphanGraceHours: num('set-upload-orphan-grace'), diskMonitoringEnabled: checked('set-disk-monitoring'), diskWarnPercent: num('set-disk-warning'), diskCriticalPercent: num('set-disk-critical'), operationalAlertsEnabled: checked('set-operational-alerts'), operationalAlertCooldownMinutes: num('set-operational-alert-cooldown'),
    telegramEnabled: checked('set-tg-enabled'), telegramCreateTopics: S.settings?.telegramMode === 'private' ? true : checked('set-tg-create-topics'), telegramAutoAssignSingleOperator: checked('set-tg-auto-assign'), telegramForwardUserMessages: checked('set-tg-forward-user'), telegramForwardAdminMessages: checked('set-tg-forward-admin'), telegramForwardOperatorMessages: checked('set-tg-forward-operator'), telegramUnansweredReminderEnabled: checked('set-tg-reminders'), telegramUnansweredReminderMinutes: num('set-tg-reminder-first'), telegramUnansweredRepeatMinutes: num('set-tg-reminder-repeat'), telegramDeleteRenameNotices: checked('set-tg-delete-renames'), telegramPinNewTicketMessage: checked('set-tg-pin'), telegramCloseTopicOnClose: checked('set-tg-close-topic'), telegramCleanupClosedTopics: checked('set-tg-cleanup'), telegramCleanupClosedHours: num('set-tg-cleanup-hours'),
    telegramCustomerEnabled: checked('set-tg-customer-enabled'), telegramCustomerFilesEnabled: checked('set-tg-customer-files'), telegramCustomerDeliverReplies: checked('set-tg-customer-replies'), telegramCustomerNewTicketText: val('set-tg-customer-new'), telegramCustomerClosedText: val('set-tg-customer-closed'), telegramCustomerClosedByUserText: val('set-tg-customer-closed-user'), telegramCustomerClosedBySupportText: val('set-tg-customer-closed-support'), telegramCustomerClosedBySystemText: val('set-tg-customer-closed-system'), telegramCustomerClosePromptText: val('set-tg-customer-close-prompt'), telegramCustomerCloseButtonText: val('set-tg-customer-close-btn'), telegramCustomerNewButtonText: val('set-tg-customer-new-btn'), telegramCustomerSendCloseButtonText: val('set-tg-customer-send-close-btn'),
    telegramRichTranscriptTitle: val('set-tg-rich-title'), telegramRichTranscriptSubtitle: val('set-tg-rich-subtitle'), telegramRichTranscriptMaxMessages: num('set-tg-rich-max-messages'), telegramRichTranscriptMessageMaxChars: num('set-tg-rich-max-chars'), telegramRichTranscriptShowAuthor: checked('set-tg-rich-author'), telegramRichTranscriptAuthorMode: val('set-tg-rich-author-mode'), telegramRichTranscriptGroupWindowMinutes: num('set-tg-rich-group-window'), telegramRichTranscriptGroupContinuation: val('set-tg-rich-group-continuation'), telegramRichTranscriptGroupSpacing: val('set-tg-rich-group-spacing'), telegramRichTranscriptShowTime: checked('set-tg-rich-time'), telegramRichTranscriptSeparator: val('set-tg-rich-separator'), telegramRichTranscriptShowHeader: checked('set-tg-rich-show-header'), telegramRichTranscriptShowSubtitle: checked('set-tg-rich-show-subtitle'), telegramRichTranscriptTitleSize: val('set-tg-rich-title-size'), telegramRichTranscriptTitleStyle: val('set-tg-rich-title-style'), telegramRichTranscriptSubtitleStyle: val('set-tg-rich-subtitle-style'), telegramRichTranscriptMessageLayout: val('set-tg-rich-layout'), telegramRichTranscriptMessageSize: val('set-tg-rich-message-size'), telegramRichTranscriptMessageHeaderStyle: val('set-tg-rich-message-header-style'), telegramRichTranscriptTimestampFormat: val('set-tg-rich-time-format'), telegramRichTranscriptDensity: val('set-tg-rich-density'), telegramRichTranscriptOrder: val('set-tg-rich-order'), telegramRichTranscriptUserLabel: val('set-tg-rich-user-label'), telegramRichTranscriptOperatorLabel: val('set-tg-rich-operator-label'), telegramRichTranscriptShowMediaLabel: checked('set-tg-rich-media-label'), telegramRichTranscriptShowOmittedNotice: checked('set-tg-rich-omitted'), telegramRichTranscriptFooter: val('set-tg-rich-footer'), telegramRichTranscriptEmptyText: val('set-tg-rich-empty'), telegramRichTranscriptEntryEffect: val('set-tg-rich-entry-effect'), telegramRichTranscriptEntryEffectDelayMs: num('set-tg-rich-entry-effect-delay'), telegramRichTranscriptEntryEffectText: val('set-tg-rich-entry-effect-text'),
    telegramTopicNameTemplate: val('set-topic-template'), telegramNewEmoji: val('set-emoji-new'), telegramOpenEmoji: val('set-emoji-open'), telegramWaitEmoji: val('set-emoji-wait'), telegramClosedEmoji: val('set-emoji-closed'), telegramCloseButtonText: val('set-close-btn'), telegramCloseButtonStyle: val('set-close-btn-style'), telegramCloseButtonEmojiId: val('set-close-btn-emoji-id'),
    telegramNewTicketText: val('set-tg-new-ticket'), telegramClosedByUserText: val('set-tg-closed-user'), telegramClosedBySupportText: val('set-tg-closed-support'), telegramAutoCloseText: val('set-tg-autoclose'), telegramWarnInactivityText: val('set-tg-warn'), telegramTopicDeletedAdminText: val('set-tg-topic-deleted')
  };
}

function setDependentControls(masterId, controlIds) {
  const master = $(masterId);
  if (!master) return;
  const disabled = !master.checked || master.disabled;
  controlIds.forEach(id => {
    const control = $(id);
    if (!control) return;
    control.disabled = disabled;
    control.closest('.field,.check')?.classList.toggle('setting-disabled', disabled);
  });
}

function applySettingsDependencies() {
  const telegramEnabled = checked('set-tg-enabled');
  document.querySelectorAll('#settings-grid [id^="set-tg-"],#settings-grid [id^="set-topic-"],#settings-grid [id^="set-emoji-"],#settings-grid [id^="set-close-"]').forEach(control => {
    if (control.id === 'set-tg-enabled') return;
    control.disabled = !telegramEnabled;
    control.closest('.field,.check')?.classList.toggle('setting-disabled', control.disabled);
  });
  setDependentControls('set-offhours-enabled', ['set-banner-text','set-reject-text']);
  setDependentControls('set-welcome-enabled', ['set-welcome-1-enabled','set-welcome-2-enabled','set-welcome-3-enabled']);
  setDependentControls('set-welcome-1-enabled', ['set-welcome-delay-1','set-welcome-1']);
  setDependentControls('set-welcome-2-enabled', ['set-welcome-delay-2','set-welcome-2']);
  setDependentControls('set-welcome-3-enabled', ['set-welcome-delay-3','set-welcome-3']);
  setDependentControls('set-operator-wait-enabled', ['set-operator-wait-delay','set-operator-wait-text']);
  setDependentControls('set-inactivity-enabled', ['set-inactivity-warn','set-inactivity-close','set-inactivity-warning','set-inactivity-close-text']);
  setDependentControls('set-backup-enabled', ['set-backup-interval','set-backup-retention','set-backup-uploads']);
  setDependentControls('set-upload-cleanup', ['set-upload-cleanup-interval','set-upload-orphan-grace']);
  setDependentControls('set-disk-monitoring', ['set-disk-warning','set-disk-critical']);
  setDependentControls('set-operational-alerts', ['set-operational-alert-cooldown']);
  setDependentControls('set-tg-customer-enabled', ['set-tg-customer-files','set-tg-customer-replies','set-tg-customer-new','set-tg-customer-closed','set-tg-customer-closed-user','set-tg-customer-closed-support','set-tg-customer-closed-system','set-tg-customer-close-prompt','set-tg-customer-close-btn','set-tg-customer-new-btn','set-tg-customer-send-close-btn']);
  setDependentControls('set-tg-reminders', ['set-tg-reminder-first','set-tg-reminder-repeat']);
  setDependentControls('set-tg-cleanup', ['set-tg-cleanup-hours']);
}

function applySettingsFilter() {
  const query = S.settingsQuery.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('.settings-card').forEach(card => {
    const categoryMatch = S.settingsFilter === 'all' || card.dataset.settingsCategory === S.settingsFilter;
    const haystack = `${card.textContent} ${card.dataset.settingsKeywords || ''}`.toLowerCase();
    const show = categoryMatch && (!query || haystack.includes(query));
    card.hidden = !show;
    if (show) visible++;
  });
  $('settings-empty')?.classList.toggle('on', visible === 0);
}

function updateSettingsDirtyState() {
  if (!$('settings-grid')) return;
  S.settingsDirty = JSON.stringify(settingsPayload()) !== S.settingsSnapshot;
  const state = $('settings-save-state');
  const save = $('set-save');
  const discard = $('settings-discard');
  if (state) state.textContent = S.settingsSaving ? 'Сохраняю…' : S.settingsDirty ? 'Есть несохранённые изменения' : 'Изменений нет';
  if (save) {
    save.disabled = !S.settingsDirty || S.settingsSaving;
    save.textContent = S.settingsSaving ? 'Сохраняю…' : 'Сохранить настройки';
  }
  if (discard) discard.disabled = !S.settingsDirty || S.settingsSaving;
}

function requestOperators() {
  socket.timeout(12000).emit('admin_get_operators', {}, (timeoutError, result) => {
    if (timeoutError || !result?.ok) return;
    S.operators = result.operators || [];
    if (S.view === 'settings') renderSettings();
  });
}

function startMiniAppRefresh() {
  if (!IS_TG_MINI || miniRefreshTimer) return;
  miniRefreshTimer = setInterval(() => refreshMiniAppState(), 4000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshMiniAppState();
  });
  refreshMiniAppState();
}

function refreshMiniAppState() {
  if (!IS_TG_MINI || miniRefreshPending || !socket.connected || document.visibilityState !== 'visible') return;
  miniRefreshPending = true;
  miniRefreshSequence += 1;
  socket.timeout(8000).emit('admin_refresh_state', {
    ticketId: S.current?.id || '',
    knownMessageId: S.messages.at(-1)?.id || '',
    knownTicketStatus: S.current?.status || '',
    // Socket events keep the UI instant. The fallback only refreshes the full
    // sidebar every fourth cycle to avoid rebuilding it unnecessarily.
    includeTickets: miniRefreshSequence % 4 === 0
  }, () => {
    miniRefreshPending = false;
  });
}

function saveManagedOperator(row) {
  const payload = {
    telegramUserId: row ? row.dataset.operatorId : val('operator-new-id'),
    displayName: row ? row.querySelector('[data-operator-name]')?.value : val('operator-new-name'),
    username: row ? row.querySelector('[data-operator-username]')?.value : val('operator-new-username'),
    active: row ? !!row.querySelector('[data-operator-active]')?.checked : checked('operator-new-active'),
    canManageSettings: row ? !!row.querySelector('[data-operator-settings]')?.checked : checked('operator-new-settings')
  };
  const button = row ? row.querySelector('[data-operator-save]') : $('operator-new-save');
  if (button) button.disabled = true;
  socket.timeout(12000).emit('admin_save_operator', payload, (timeoutError, result) => {
    if (button) button.disabled = false;
    if (timeoutError || !result?.ok) return toast(result?.error || 'Не удалось сохранить оператора', 'err');
    const saved = result.operator;
    if (saved) {
      const index = S.operators.findIndex(item => item.telegramUserId === saved.telegramUserId);
      if (index >= 0) S.operators[index] = saved;
      else S.operators.push(saved);
      S.operators.sort((a, b) => Number(b.active) - Number(a.active) || String(a.displayName).localeCompare(String(b.displayName), 'ru'));
      if (S.view === 'settings') renderSettings();
    }
    toast('Права оператора сохранены', 'ok');
    requestOperators();
  });
}

function bindSettingsUi() {
  applySettingsDependencies();
  renderRichTranscriptPreview();
  S.settingsSnapshot = JSON.stringify(settingsPayload());
  S.settingsDirty = false;
  $('settings-search')?.addEventListener('input', event => {
    S.settingsQuery = event.target.value;
    applySettingsFilter();
  });
  document.querySelectorAll('[data-settings-filter]').forEach(button => button.addEventListener('click', () => {
    S.settingsFilter = button.dataset.settingsFilter || 'all';
    document.querySelectorAll('[data-settings-filter]').forEach(item => item.classList.toggle('on', item === button));
    applySettingsFilter();
  }));
  document.querySelectorAll('#settings-grid input:not([data-operator-name]):not([data-operator-username]):not([data-operator-active]):not([data-operator-settings]),#settings-grid textarea,#settings-grid select').forEach(control => {
    control.addEventListener('input', () => {
      renderRichTranscriptPreview();
      updateSettingsDirtyState();
    });
    control.addEventListener('change', () => {
      applySettingsDependencies();
      renderRichTranscriptPreview();
      updateSettingsDirtyState();
    });
  });
  document.querySelectorAll('[data-rich-preset]').forEach(button => button.addEventListener('click', () => {
    applyRichPreset(button.dataset.richPreset);
  }));
  $('set-save')?.addEventListener('click', saveSettings);
  $('settings-discard')?.addEventListener('click', renderSettings);
  $('settings-export')?.addEventListener('click', exportSettings);
  $('settings-test-alert')?.addEventListener('click', testOperationalAlert);
  document.querySelectorAll('[data-operator-save]').forEach(button => button.addEventListener('click', () => {
    saveManagedOperator(button.closest('[data-operator-id]'));
  }));
  $('operator-new-save')?.addEventListener('click', () => saveManagedOperator(null));
  applySettingsFilter();
  updateSettingsDirtyState();
}

function validateSettings(payload) {
  const invalid = document.querySelector('#settings-grid input:invalid,#settings-grid textarea:invalid,#settings-grid select:invalid');
  if (invalid) {
    invalid.focus();
    return 'Проверьте выделенное значение';
  }
  if (payload.inactivityCloseMinutes <= payload.inactivityWarnMinutes) {
    $('set-inactivity-close')?.focus();
    return 'Автозакрытие должно происходить позже предупреждения';
  }
  if (payload.diskCriticalPercent <= payload.diskWarnPercent) {
    $('set-disk-critical')?.focus();
    return 'Критический порог диска должен быть выше предупреждения';
  }
  return '';
}

function saveSettings() {
  if (S.settingsSaving || !S.settingsDirty) return;
  const payload = settingsPayload();
  const error = validateSettings(payload);
  if (error) return toast(error, 'err');
  S.settingsSaving = true;
  updateSettingsDirtyState();
  socket.timeout(12000).emit('admin_update_settings', payload, (timeoutError, result) => {
    S.settingsSaving = false;
    if (timeoutError || !result?.ok) {
      updateSettingsDirtyState();
      return toast(result?.error || 'Сервер не подтвердил сохранение', 'err');
    }
    S.settings = result.settings || payload;
    window.supportAdminSettings = S.settings;
    S.settingsLastSavedAt = result.savedAt || new Date().toISOString();
    renderSettings();
    toast('Настройки сохранены и применены', 'ok');
  });
}

function exportSettings() {
  const payload = settingsPayload();
  const blob = new Blob([JSON.stringify({
    exportedAt: new Date().toISOString(),
    version: 1,
    settings: payload
  }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `support-settings-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
  toast('Настройки экспортированы', 'ok');
}

function testOperationalAlert() {
  const button = $('settings-test-alert');
  if (button) button.disabled = true;
  socket.timeout(12000).emit('admin_test_operational_alert', {}, (timeoutError, result) => {
    if (button) button.disabled = false;
    if (timeoutError || !result?.ok) {
      return toast(result?.error || 'Тестовое уведомление не подтверждено', 'err');
    }
    toast('Тестовое уведомление отправлено', 'ok');
  });
}

function renderTemplates() { $('templates').innerHTML = `<div class="section"><h2>Шаблоны ответов</h2><p>Шаблоны хранятся в браузере оператора и доступны в чате по кнопке #.</p><div class="card"><div id="tpl-list" class="template-list"></div><button id="tpl-add" class="add">Добавить шаблон</button><button id="tpl-reset" class="ghost" style="margin-left:8px">Вернуть стандартные</button></div></div>`; renderTemplateRows(); $('tpl-add').addEventListener('click', () => { S.templates.push({ label: 'Новый', text: '' }); saveTemplates(); renderTemplateRows(); }); $('tpl-reset').addEventListener('click', () => { S.templates = DEFAULT_TEMPLATES.slice(); saveTemplates(); renderTemplateRows(); toast('Шаблоны восстановлены', 'ok'); }); }
function renderTemplateRows() { const list = $('tpl-list'); if (!list) return; list.innerHTML = S.templates.map((t, i) => `<div class="tpl" data-i="${i}"><input class="tpl-label" value="${esc(t.label)}" placeholder="Название"><input class="tpl-text" value="${esc(t.text)}" placeholder="Текст ответа"><button title="Удалить">×</button></div>`).join('') || '<div class="empty">Шаблонов нет</div>'; list.querySelectorAll('.tpl').forEach(row => { const i = Number(row.dataset.i); row.querySelector('.tpl-label').addEventListener('input', e => { S.templates[i].label = e.target.value; saveTemplates(); }); row.querySelector('.tpl-text').addEventListener('input', e => { S.templates[i].text = e.target.value; saveTemplates(); }); row.querySelector('button').addEventListener('click', () => { S.templates.splice(i, 1); saveTemplates(); renderTemplateRows(); }); }); }

function fmtBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} МБ`;
  return `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
}

function fmtStatusDate(value) {
  if (!value) return 'ещё не выполнялось';
  const date = parseServerDate(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
}

async function adminMaintenanceApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.headers || {}), 'X-Admin-Token': S.token }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка HTTP ${response.status}`);
  return data;
}

async function loadMaintenance() {
  if (!S.token) return;
  try {
    const [maintenance, health] = await Promise.all([
      adminMaintenanceApi('/api/admin/maintenance'),
      adminMaintenanceApi('/api/admin/health')
    ]);
    S.maintenance = maintenance;
    S.systemHealth = health;
    renderMaintenance();
  } catch (error) {
    if (S.view === 'health') toast(error.message || 'Не удалось получить состояние системы', 'err');
  }
}

async function runMaintenanceAction(action) {
  const button = $(`maintenance-${action}`);
  if (button) button.disabled = true;
  try {
    const data = await adminMaintenanceApi(`/api/admin/maintenance/${action}`, { method: 'POST' });
    S.maintenance = data.status || S.maintenance;
    toast(action === 'backup' ? 'Резервная копия создана' : `Очистка завершена: удалено ${data.removed || 0}`, 'ok');
  } catch (error) {
    toast(error.message || 'Операция не выполнена', 'err');
  } finally {
    renderMaintenance();
  }
}

function renderMaintenance() {
  const root = $('health');
  if (!root) return;
  const m = S.maintenance;
  if (!m) {
    root.innerHTML = '<div class="section"><h2>Состояние системы</h2><p>Проверяю резервные копии, файлы и свободное место…</p><div class="card maintenance-loading">Загрузка…</div></div>';
    return;
  }
  const diskClass = !m.config?.diskMonitoringEnabled ? '' : m.diskLevel === 'critical' ? 'critical' : m.diskLevel === 'warning' ? 'warning' : 'ok';
  const backupClass = !m.config?.backupEnabled ? '' : m.lastBackupError || m.backupOverdue ? 'critical' : m.lastBackupAt ? 'ok' : 'warning';
  const backupLabel = !m.config?.backupEnabled ? 'Выключен' : m.lastBackupError ? 'Ошибка' : m.backupOverdue ? 'Просрочен' : m.lastBackupAt ? 'Готов' : 'Ожидается';
  const tg = S.systemHealth?.telegram;
  const tgDelivery = tg?.delivery || {};
  const telegramHealthy = !!(tg?.configured && tg?.enabled && tg?.connected &&
    (tg?.mode !== 'private' || tg?.polling?.owner));
  const telegramBacklog = Number(tgDelivery.pendingIncomingMessages || 0) +
    Number(tgDelivery.pendingMessages || 0) + Number(tgDelivery.pendingCustomerReplies || 0);
  const telegramClass = !tg?.configured || !tg?.enabled ? 'warning' : telegramHealthy && !telegramBacklog ? 'ok' : 'critical';
  const telegramLabel = !tg?.configured ? 'Не настроен' : !tg?.enabled ? 'Выключен' : telegramHealthy ? 'На связи' : 'Нет связи';
  root.innerHTML = `<div class="section maintenance-section">
    <div class="maintenance-title"><div><h2>Состояние системы</h2><p>Резервные копии, загрузки и состояние диска обновляются автоматически.</p></div><button id="maintenance-refresh" class="ghost">Обновить</button></div>
    <div class="maintenance-summary">
      <div class="health-stat ${backupClass}"><span>Backup</span><b>${backupLabel}</b><small>${esc(fmtStatusDate(m.lastBackupAt))}</small></div>
      <div class="health-stat ${diskClass}"><span>Диск</span><b>${m.disk ? `${m.disk.usedPercent}%` : '—'}</b><small>${m.disk ? `${fmtBytes(m.disk.freeBytes)} свободно` : 'нет данных'}</small></div>
      <div class="health-stat"><span>Загрузки</span><b>${Number(m.uploads?.files || 0)}</b><small>${fmtBytes(m.uploads?.bytes)}</small></div>
      <div class="health-stat"><span>Очистка</span><b>${Number(m.lastCleanupRemoved || 0)}</b><small>${esc(fmtStatusDate(m.lastCleanupAt))}</small></div>
    </div>
    <div class="card">
      <h3>Telegram и доставка</h3>
      <div class="maintenance-summary">
        <div class="health-stat ${telegramClass}"><span>Бот</span><b>${telegramLabel}</b><small>${esc(tg?.botUsername ? `@${tg.botUsername}` : tg?.mode || '—')}</small></div>
        <div class="health-stat ${telegramBacklog ? 'warning' : 'ok'}"><span>Очередь</span><b>${telegramBacklog}</b><small>входящие ${Number(tgDelivery.pendingIncomingMessages || 0)} · оператору ${Number(tgDelivery.pendingMessages || 0)} · клиенту ${Number(tgDelivery.pendingCustomerReplies || 0)}</small></div>
        <div class="health-stat ${Number(tg?.polling?.conflicts || 0) ? 'warning' : 'ok'}"><span>Polling</span><b>${tg?.mode !== 'private' || tg?.polling?.owner ? 'активен' : 'ожидает'}</b><small>конфликтов ${Number(tg?.polling?.conflicts || 0)}</small></div>
        <div class="health-stat ${Number(tgDelivery.mediaFailures || 0) ? 'warning' : 'ok'}"><span>Медиа</span><b>${Number(tgDelivery.mediaFailures || 0)}</b><small>ошибок загрузки</small></div>
      </div>
      <dl class="health-details">
        <div><dt>Последняя успешная доставка</dt><dd>${esc(fmtStatusDate(tgDelivery.lastSuccessAt))}</dd></div>
        <div><dt>Самое старое входящее</dt><dd>${tgDelivery.oldestIncomingMessageSeconds == null ? '—' : `${Number(tgDelivery.oldestIncomingMessageSeconds)} сек.`}</dd></div>
        <div><dt>Самый старый ответ клиенту</dt><dd>${tgDelivery.oldestCustomerReplySeconds == null ? '—' : `${Number(tgDelivery.oldestCustomerReplySeconds)} сек.`}</dd></div>
        <div><dt>Threaded Mode</dt><dd>${tg?.threadedModeEnabled ? 'включён' : 'не подтверждён'}</dd></div>
      </dl>
      ${tgDelivery.lastError ? `<div class="health-error">${esc(tgDelivery.lastError)}</div>` : ''}
    </div>
    <div class="grid maintenance-grid">
      <div class="card">
        <h3>Резервное копирование</h3>
        <p class="muted">SQLite-копия проверяется на целостность. Загруженные файлы синхронизируются в отдельное хранилище без повторного копирования неизменённых файлов.</p>
        <dl class="health-details">
          <div><dt>Хранилище</dt><dd>${esc(m.backupDir || '—')}</dd></div>
          <div><dt>Последний файл</dt><dd>${esc(m.lastBackupFile || '—')}</dd></div>
          <div><dt>Размер базы</dt><dd>${fmtBytes(m.lastBackupBytes)}</dd></div>
          <div><dt>Длительность</dt><dd>${m.lastBackupDurationMs == null ? '—' : `${m.lastBackupDurationMs} мс`}</dd></div>
          <div><dt>Хранится копий</dt><dd>${Number(m.config?.backupRetention || 0)}</dd></div>
          <div><dt>Интервал</dt><dd>${Number(m.config?.backupIntervalHours || 0)} ч</dd></div>
          <div><dt>Файлы</dt><dd>${m.config?.backupUploadsEnabled ? 'копируются' : 'выключено'}</dd></div>
        </dl>
        ${m.lastBackupError ? `<div class="health-error">${esc(m.lastBackupError)}</div>` : ''}
        <button id="maintenance-backup" class="save" ${m.backupInProgress ? 'disabled' : ''}>${m.backupInProgress ? 'Создаю копию…' : 'Создать копию сейчас'}</button>
      </div>
      <div class="card">
        <h3>Файлы и место</h3>
        <p class="muted">Удаляются только файлы, которые не привязаны ни к одному сообщению и старше защитного периода.</p>
        <dl class="health-details">
          <div><dt>Защитный период</dt><dd>${Number(m.config?.uploadOrphanGraceHours || 0)} ч</dd></div>
          <div><dt>Автоочистка</dt><dd>${m.config?.uploadCleanupEnabled ? `каждые ${Number(m.config.uploadCleanupIntervalHours || 0)} ч` : 'выключена'}</dd></div>
          <div><dt>Удалено в прошлый раз</dt><dd>${Number(m.lastCleanupRemoved || 0)}</dd></div>
          <div><dt>Освобождено</dt><dd>${fmtBytes(m.lastCleanupFreedBytes)}</dd></div>
          <div><dt>Контроль диска</dt><dd>${m.config?.diskMonitoringEnabled ? 'включён' : 'выключен'}</dd></div>
          <div><dt>Предупреждение</dt><dd>${Number(m.config?.diskWarnPercent || 0)}%</dd></div>
          <div><dt>Критический уровень</dt><dd>${Number(m.config?.diskCriticalPercent || 0)}%</dd></div>
        </dl>
        ${m.lastCleanupError ? `<div class="health-error">${esc(m.lastCleanupError)}</div>` : ''}
        <button id="maintenance-cleanup" class="ghost" ${m.cleanupInProgress ? 'disabled' : ''}>${m.cleanupInProgress ? 'Проверяю…' : 'Очистить осиротевшие файлы'}</button>
      </div>
    </div>
  </div>`;
  $('maintenance-refresh')?.addEventListener('click', loadMaintenance);
  $('maintenance-backup')?.addEventListener('click', () => runMaintenanceAction('backup'));
  $('maintenance-cleanup')?.addEventListener('click', () => runMaintenanceAction('cleanup'));
}

init();
