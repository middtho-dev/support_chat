'use strict';

const DEFAULT_TEMPLATES = [
  { label: 'Приветствие', text: 'Добрый день! Чем могу помочь?' },
  { label: 'Ожидание', text: 'Уточняю информацию, вернусь к вам в ближайшее время.' },
  { label: 'Переустановка', text: 'Попробуйте переустановить VPN-клиент и перезагрузить устройство.' },
  { label: 'Смена сервера', text: 'Попробуйте сменить сервер в настройках приложения.' },
  { label: 'Скриншот', text: 'Пришлите, пожалуйста, скриншот ошибки — это ускорит решение.' },
  { label: 'Завершение', text: 'Спасибо за обращение в поддержку KV9RU! Будем рады помочь снова.' }
];
const COLORS = ['#2563eb','#7c3aed','#db2777','#dc2626','#d97706','#059669','#0891b2','#9333ea'];
const S = { token: null, tickets: [], filter: 'open', search: '', current: null, messages: [], settings: null, templates: loadTemplates(), view: 'chat', lastDate: '', file: null, uploading: false };
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

const esc = value => value == null ? '' : String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
const linkify = value => value.replace(/https?:\/\/[^\s<>"']+/g, url => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
const fmtTime = date => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDate = date => date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
function timeAgo(iso) { const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000)); if (sec < 60) return 'сейчас'; if (sec < 3600) return `${Math.floor(sec / 60)} мин`; if (sec < 86400) return `${Math.floor(sec / 3600)} ч`; return `${Math.floor(sec / 86400)} д`; }
function avatarColor(name = '') { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff; return COLORS[h % COLORS.length]; }
function initials(name = '') { return (name.trim() || '?').slice(0, 2).toUpperCase(); }
function loadTemplates() { try { return JSON.parse(localStorage.getItem('admin_templates')) || DEFAULT_TEMPLATES; } catch { return DEFAULT_TEMPLATES; } }
function saveTemplates() { localStorage.setItem('admin_templates', JSON.stringify(S.templates)); }
let toastTimer;
function toast(text, type = 'info') { const el = $('toast'); clearTimeout(toastTimer); el.textContent = text; el.style.borderColor = type === 'err' ? 'rgba(251,113,133,.45)' : type === 'ok' ? 'rgba(52,211,153,.45)' : ''; el.classList.add('on'); toastTimer = setTimeout(() => el.classList.remove('on'), 2800); }
function setConn(state) { $('cdot').className = `dot ${state}`; $('ctxt').textContent = state === 'on' ? 'онлайн' : state === 'off' ? 'нет соединения' : 'подключение'; }

function init() {
  bindStaticUi();
  renderSettings();
  renderTemplates();
  const saved = sessionStorage.getItem('admin_token');
  if (saved) { S.token = saved; setConn(''); socket.connect(); }
  else setTimeout(() => $('tok')?.focus(), 100);
  setInterval(renderRelativeTimes, 30000);
}

function bindStaticUi() {
  $('login-form').addEventListener('submit', event => { event.preventDefault(); login(); });
  $('logout-btn').addEventListener('click', logout);
  $('srch').addEventListener('input', () => { S.search = $('srch').value.trim().toLowerCase(); renderSidebar(); });
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => setFilter(btn.dataset.tab)));
  document.querySelectorAll('.navbtn').forEach(btn => btn.addEventListener('click', () => setView(btn.dataset.view)));
  $('back').addEventListener('click', () => $('main').classList.remove('open'));
  $('cv-toggle').addEventListener('click', toggleTicketStatus);
  document.addEventListener('click', event => { if (!event.target.closest('.pop') && event.target !== $('quick')) document.querySelectorAll('.pop').forEach(p => p.remove()); });
}

function login() { const token = $('tok').value.trim(); if (!token) return; S.token = token; $('lbtn').disabled = true; $('lerr').textContent = ''; setConn(''); socket.connect(); }
function logout() { sessionStorage.removeItem('admin_token'); socket.disconnect(); S.token = null; S.tickets = []; S.current = null; S.messages = []; $('app').style.display = 'none'; $('login').style.display = 'grid'; $('tok').value = ''; $('lbtn').disabled = false; setConn('off'); }

socket.on('connect', () => { setConn('on'); if (S.token) socket.emit('admin_auth', { token: S.token }); });
socket.on('disconnect', () => setConn('off'));
socket.io.on('reconnect_attempt', () => setConn('connecting'));

socket.on('admin_auth_ok', () => {
  sessionStorage.setItem('admin_token', S.token);
  $('login').style.display = 'none';
  $('app').style.display = 'grid';
  socket.emit('admin_get_settings');
});
socket.on('admin_settings', s => {
  S.settings = s || {};
  renderSettings();
});
socket.on('admin_settings_updated', s => {
  S.settings = s || {};
  if (S.view === 'settings') renderSettings();
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

socket.on('admin_error', ({ message }) => toast(message, 'err'));

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
  S.view = view || 'chat';
  document.querySelectorAll('.navbtn').forEach(btn => btn.classList.toggle('on', btn.dataset.view === S.view));
  $('settings').classList.toggle('on', S.view === 'settings');
  $('templates').classList.toggle('on', S.view === 'templates');

  if (S.view === 'chat') {
    $('welcome').style.display = S.current ? 'none' : 'grid';
    $('chat').style.display = S.current ? 'flex' : 'none';
  } else {
    $('welcome').style.display = 'none';
    $('chat').style.display = 'none';
    $('main').classList.add('open');
  }
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
function ticketHtml(t) { const ts = t.last_activity || t.created_at; const badge = t.unread_count > 0 ? `<div class="badge">${t.unread_count}</div>` : ''; return `<button class="ticket ${S.current?.id === t.id ? 'on' : ''}" data-id="${esc(t.id)}"><div class="avatar ${t.status === 'closed' ? 'closed' : t.unread_count > 0 ? 'wait' : ''}" style="background:${avatarColor(t.user_name)}">${esc(initials(t.user_name))}</div><div><div class="tname">${esc(t.user_name)}</div><div class="tlast">${preview(t)}</div></div><div><div class="time" data-ts="${esc(ts)}">${timeAgo(ts)}</div>${badge}</div></button>`; }
function preview(t) { if (!t.last_msg && !t.last_msg_type) return '<span>нет сообщений</span>'; const prefix = t.last_sender === 'support' ? 'Вы: ' : ''; if (t.last_msg_type && t.last_msg_type !== 'text') return esc(prefix + (t.last_msg_type === 'image' ? 'Фото' : t.last_msg_type === 'video' ? 'Видео' : t.last_msg_type === 'audio' ? 'Аудио' : 'Файл')); return esc(prefix + (t.last_msg || '').slice(0, 80)); }
function renderRelativeTimes() { document.querySelectorAll('[data-ts]').forEach(el => { el.textContent = timeAgo(el.dataset.ts); }); }

function openTicket(id) { const ticket = S.tickets.find(t => t.id === id); if (!ticket) return; S.current = ticket; S.current.unread_count = 0; S.messages = []; S.lastDate = ''; setView('chat'); $('main').classList.add('open'); $('welcome').style.display = 'none'; $('chat').style.display = 'flex'; $('cv-msgs').innerHTML = '<div class="empty">Загрузка сообщений...</div>'; renderSidebar(); renderChatHeader(); socket.emit('admin_open_ticket', { ticketId: id }); }
function renderChatHeader() { if (!S.current) return; const t = S.current; $('cv-av').style.background = avatarColor(t.user_name); $('cv-av').textContent = initials(t.user_name); $('cv-av').className = `avatar ${t.status === 'closed' ? 'closed' : ''}`; $('cv-name').textContent = t.user_name; $('cv-sub').textContent = `#${t.id.slice(0, 8)} · ${fmtDate(new Date(t.created_at))} · ${t.status === 'open' ? 'открыто' : 'закрыто'}`; const btn = $('cv-toggle'); btn.disabled = !!t.telegram_topic_deleted; btn.className = t.status === 'open' ? 'danger' : 'okbtn'; btn.textContent = t.status === 'open' ? 'Закрыть' : (t.telegram_topic_deleted ? 'Тема удалена' : 'Переоткрыть'); $('composer').innerHTML = t.status === 'open' ? composerHtml() : '<div class="closed-note">Обращение закрыто. При необходимости переоткройте его.</div>'; if (t.status === 'open') wireComposer(); }
function composerHtml() { return `<div id="admin-file-preview" class="admin-file-preview" style="display:none"></div><div class="compose-row"><button id="quick" class="quick" title="Шаблоны">#</button><button id="reply-attach" class="quick" title="Прикрепить файл">+</button><input id="reply-file" type="file" accept="image/*,video/*,audio/*,.heic,.heif,.avif,.pdf,.doc,.docx,.zip,.txt,.csv,.xls,.xlsx,.pptx,.7z,.rar" style="display:none"><textarea id="reply-txt" rows="1" placeholder="Ответ оператора..."></textarea><button id="reply-send" class="send" disabled>➤</button></div><div class="hint"><span>Ctrl+Enter — отправить</span><span id="reply-cnt"></span></div>`; }
function wireComposer() { S.file = null; S.uploading = false; $('reply-txt').addEventListener('input', onReplyInput); $('reply-txt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } }); $('reply-send').addEventListener('click', sendReply); $('quick').addEventListener('click', showTemplatePicker); $('reply-attach').addEventListener('click', () => $('reply-file').click()); $('reply-file').addEventListener('change', () => { if ($('reply-file').files[0]) setReplyFile($('reply-file').files[0]); $('reply-file').value = ''; }); }
function renderConversation() { const box = $('cv-msgs'); box.innerHTML = ''; S.lastDate = ''; if (!S.messages.length) { box.innerHTML = '<div class="empty">Сообщений пока нет</div>'; return; } S.messages.forEach(m => appendMessage(m, false)); scrollBottom(false); }
function appendMessage(msg, scroll = false) { const box = $('cv-msgs'); if (!box) return; box.querySelector('.empty')?.remove(); if (msg.sender !== 'system') { const ds = fmtDate(new Date(msg.created_at)); if (ds !== S.lastDate) { S.lastDate = ds; box.insertAdjacentHTML('beforeend', `<div class="day">${esc(ds)}</div>`); } } const out = msg.sender === 'support'; const sys = msg.sender === 'system'; const sender = !out && !sys ? `<div class="sender">${esc(msg.sender_name || 'Клиент')}</div>` : ''; box.insertAdjacentHTML('beforeend', `<div class="msg ${sys ? 'sys' : out ? 'out' : 'in'}"><div class="bubble">${sender}${messageBody(msg)}<div class="meta">${fmtTime(new Date(msg.created_at))}</div></div></div>`); if (scroll) scrollBottom(true); }
function messageBody(msg) { const text = msg.content ? `<div>${linkify(esc(msg.content))}</div>` : ''; if (msg.message_type === 'image' && msg.file_url) return `<img src="${esc(msg.file_url)}" loading="lazy">${text}`; if (msg.message_type === 'video' && msg.file_url) return `<video src="${esc(msg.file_url)}" controls preload="metadata"></video>${text}`; if (msg.message_type === 'audio' && msg.file_url) return `<audio src="${esc(msg.file_url)}" controls></audio>${text}`; if (msg.file_url) return `<a class="file" href="${esc(msg.file_url)}" target="_blank" rel="noopener noreferrer" download="${esc(msg.file_name || 'file')}"><span class="file-ico">↧</span><span>${esc(msg.file_name || 'Файл')}</span></a>${text}`; return text || '<span></span>'; }
function scrollBottom(smooth) { const box = $('cv-msgs'); requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); }
function onReplyInput() { const txt = $('reply-txt'), send = $('reply-send'), cnt = $('reply-cnt'); if (!txt || !send) return; txt.style.height = 'auto'; txt.style.height = `${Math.min(txt.scrollHeight, 140)}px`; send.disabled = S.uploading || (!txt.value.trim() && !S.file); if (cnt) cnt.textContent = txt.value ? `${txt.value.length} симв.` : ''; socket.emit('admin_typing', { ticketId: S.current?.id }); }
async function sendReply() {
  const txt = $('reply-txt');
  if (!txt || !S.current || S.current.status !== 'open' || S.uploading) return;
  const content = txt.value.trim();
  const file = S.file;
  if (!content && !file) return;
  $('reply-send').disabled = true;
  let fileUrl = null, fileName = null, fileMime = null, messageType = 'text';
  if (file) {
    S.uploading = true;
    renderReplyFilePreview('Загрузка...');
    try {
      const fd = new FormData();
      fd.append('adminToken', S.token);
      fd.append('file', file);
      const r = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!r.ok) throw 0;
      const d = await r.json();
      fileUrl = d.url; fileName = d.name; fileMime = d.mime; messageType = d.type;
    } catch {
      S.uploading = false;
      toast('Ошибка загрузки файла', 'err');
      onReplyInput();
      renderReplyFilePreview();
      return;
    }
    S.uploading = false;
    clearReplyFile();
  }
  txt.value = '';
  txt.style.height = 'auto';
  $('reply-cnt').textContent = '';
  socket.emit('admin_reply', { ticketId: S.current.id, content, fileUrl, fileName, fileMime, messageType });
  onReplyInput();
}
function setReplyFile(file) {
  const maxMb = Number(S.settings?.uploadMaxMb) || 50;
  if (file.size > maxMb * 1024 * 1024) return toast(`Файл слишком большой (макс. ${maxMb} МБ)`, 'err');
  S.file = file;
  renderReplyFilePreview();
  onReplyInput();
}
function clearReplyFile() {
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
function toggleTicketStatus() { if (!S.current) return; socket.emit(S.current.status === 'open' ? 'admin_close_ticket' : 'admin_reopen_ticket', { ticketId: S.current.id }); }

function showTemplatePicker(event) { event.stopPropagation(); document.querySelectorAll('.pop').forEach(p => p.remove()); const pop = document.createElement('div'); pop.className = 'pop'; pop.innerHTML = S.templates.map((t, i) => `<button data-i="${i}"><b>${esc(t.label)}</b><span>${esc(t.text)}</span></button>`).join('') || '<div class="empty">Шаблонов нет</div>'; document.body.appendChild(pop); const r = $('quick').getBoundingClientRect(); pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)}px`; pop.style.top = `${Math.max(74, r.top - pop.offsetHeight - 10)}px`; pop.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { const item = S.templates[Number(btn.dataset.i)]; const txt = $('reply-txt'); txt.value = item.text; txt.dispatchEvent(new Event('input')); txt.focus(); pop.remove(); })); }

function input(id, label, value, type = 'text', attrs = '') { return `<div class="field"><label>${label}</label><input id="${id}" type="${type}" value="${esc(value ?? '')}" ${attrs}></div>`; }
function area(id, label, value, rows = 3) { return `<div class="field"><label>${label}</label><textarea id="${id}" rows="${rows}">${esc(value ?? '')}</textarea></div>`; }
function check(id, label, value) { return `<label class="check"><input id="${id}" type="checkbox" ${value ? 'checked' : ''}> ${label}</label>`; }
function val(id) { return $(id)?.value ?? ''; }
function num(id) { return Number(val(id)); }
function checked(id) { return !!$(id)?.checked; }

function renderSettings() {
  const s = S.settings || {};
  $('settings').innerHTML = `<div class="section"><h2>Настройки проекта</h2><p>Все параметры применяются сразу после сохранения. Переменные .env вроде токена бота и ADMIN_TOKEN остаются на сервере.</p>
  <div class="grid">
    <div class="card"><h3>Чат и график</h3>${input('set-support-name','Имя поддержки в чате',s.supportName || 'Поддержка KV9RU')}${input('set-tz','Часовой пояс',s.timezone || 'Europe/Moscow')}${input('set-work-start','Начало рабочего часа',s.workStartHour ?? 8,'number','min="0" max="23"')}${input('set-work-end','Конец рабочего часа',s.workEndHour ?? 23,'number','min="1" max="24"')}${check('set-offhours-enabled','Показывать предупреждение вне графика',s.offhoursEnabled)}${area('set-banner-text','Баннер перед вводом имени вне графика',s.offhoursBannerText || '')}${area('set-reject-text','Резервный текст предупреждения вне графика',s.offhoursRejectText || '')}</div>
    <div class="card"><h3>Приветствие и ограничения</h3>${check('set-welcome-enabled','Отправлять авто-приветствие',s.welcomeEnabled)}${input('set-welcome-delay-1','Задержка первого приветствия, мс',s.welcomeDelayFirstMs ?? 1200,'number','min="0" max="30000"')}${input('set-welcome-delay-2','Задержка второго приветствия, мс',s.welcomeDelaySecondMs ?? 2800,'number','min="0" max="60000"')}${area('set-welcome-1','Первое приветствие',s.welcomeText1 || '',3)}${area('set-welcome-2','Второе приветствие',s.welcomeText2 || '',4)}${input('set-rate','Лимит сообщений в минуту',s.messageRateLimitPerMinute ?? 20,'number','min="1" max="300"')}${input('set-upload','Максимальный файл, МБ',s.uploadMaxMb ?? 50,'number','min="1" max="50"')}</div>
    <div class="card"><h3>Автозакрытие</h3>${check('set-inactivity-enabled','Включить предупреждение и автозакрытие',s.inactivityEnabled)}${input('set-inactivity-warn','Предупредить через, минут',s.inactivityWarnMinutes ?? 45,'number','min="1" max="1440"')}${input('set-inactivity-close','Закрыть через, минут',s.inactivityCloseMinutes ?? 60,'number','min="2" max="2880"')}${area('set-inactivity-warning','Сообщение-предупреждение в чат',s.inactivityWarningText || '',3)}${area('set-inactivity-close-text','Сообщение автозакрытия в чат',s.inactivityCloseText || '',3)}</div>
    <div class="card"><h3>Telegram: поведение</h3>${check('set-tg-enabled','Включить Telegram-интеграцию',s.telegramEnabled)}${check('set-tg-create-topics','Создавать темы для тикетов',s.telegramCreateTopics)}${check('set-tg-forward-user','Пересылать сообщения клиента в Telegram',s.telegramForwardUserMessages)}${check('set-tg-forward-admin','Пересылать ответы из админки в Telegram',s.telegramForwardAdminMessages)}${check('set-tg-forward-operator','Принимать ответы операторов из Telegram в чат',s.telegramForwardOperatorMessages)}${check('set-tg-delete-renames','Удалять сервисные сообщения о переименовании тем',s.telegramDeleteRenameNotices)}${check('set-tg-pin','Закреплять карточку нового тикета',s.telegramPinNewTicketMessage)}${check('set-tg-close-topic','Закрывать тему при закрытии тикета',s.telegramCloseTopicOnClose)}${check('set-tg-reopen-topic','Открывать тему при переоткрытии',s.telegramReopenTopicOnReopen)}${check('set-tg-cleanup','Удалять старые закрытые темы',s.telegramCleanupClosedTopics)}${input('set-tg-cleanup-hours','Удалять закрытые темы через, часов',s.telegramCleanupClosedHours ?? 24,'number','min="1" max="720"')}</div>
    <div class="card"><h3>Telegram: темы и кнопки</h3>${input('set-topic-template','Шаблон названия темы',s.telegramTopicNameTemplate || '{emoji} {name} • {date}')}${input('set-emoji-new','Эмодзи новой темы',s.telegramNewEmoji || '❗')}${input('set-emoji-open','Эмодзи в работе',s.telegramOpenEmoji || '🔵')}${input('set-emoji-wait','Эмодзи ждет оператора',s.telegramWaitEmoji || '🔔')}${input('set-emoji-closed','Эмодзи закрыто',s.telegramClosedEmoji || '🗑️')}${input('set-close-btn','Текст кнопки закрытия',s.telegramCloseButtonText || '🗑️ Закрыть тикет')}${input('set-reopen-btn','Текст кнопки переоткрытия',s.telegramReopenButtonText || '🟢 Переоткрыть')}</div>
    <div class="card"><h3>Telegram: тексты</h3>${area('set-tg-new-ticket','Карточка нового тикета',s.telegramNewTicketText || '',5)}${area('set-tg-closed-user','Закрыто пользователем',s.telegramClosedByUserText || '',2)}${area('set-tg-closed-support','Закрыто оператором',s.telegramClosedBySupportText || '',2)}${area('set-tg-reopened','Переоткрыто из Telegram',s.telegramReopenedText || '',2)}${area('set-tg-reopened-user','Переоткрыто пользователем',s.telegramReopenedByUserText || '',2)}${area('set-tg-autoclose','Автозакрытие в Telegram',s.telegramAutoCloseText || '',3)}${area('set-tg-warn','Предупреждение о неактивности в Telegram',s.telegramWarnInactivityText || '',3)}${area('set-tg-topic-deleted','Ошибка удаленной темы в админке',s.telegramTopicDeletedAdminText || '',2)}</div>
  </div><p style="margin-top:14px">Переменные для шаблонов: {name}, {shortId}, {date}, {dateTime}, {emoji}, {minutes}, {warnMinutes}, {remainingMinutes}.</p><button id="set-save" class="save">Сохранить все настройки</button></div>`;
  $('set-save').addEventListener('click', saveSettings);
}

function saveSettings() {
  const payload = {
    supportName: val('set-support-name'), timezone: val('set-tz'), workStartHour: num('set-work-start'), workEndHour: num('set-work-end'), offhoursEnabled: checked('set-offhours-enabled'), offhoursBannerText: val('set-banner-text'), offhoursRejectText: val('set-reject-text'),
    welcomeEnabled: checked('set-welcome-enabled'), welcomeDelayFirstMs: num('set-welcome-delay-1'), welcomeDelaySecondMs: num('set-welcome-delay-2'), welcomeText1: val('set-welcome-1'), welcomeText2: val('set-welcome-2'), messageRateLimitPerMinute: num('set-rate'), uploadMaxMb: num('set-upload'),
    inactivityEnabled: checked('set-inactivity-enabled'), inactivityWarnMinutes: num('set-inactivity-warn'), inactivityCloseMinutes: num('set-inactivity-close'), inactivityWarningText: val('set-inactivity-warning'), inactivityCloseText: val('set-inactivity-close-text'),
    telegramEnabled: checked('set-tg-enabled'), telegramCreateTopics: checked('set-tg-create-topics'), telegramForwardUserMessages: checked('set-tg-forward-user'), telegramForwardAdminMessages: checked('set-tg-forward-admin'), telegramForwardOperatorMessages: checked('set-tg-forward-operator'), telegramDeleteRenameNotices: checked('set-tg-delete-renames'), telegramPinNewTicketMessage: checked('set-tg-pin'), telegramCloseTopicOnClose: checked('set-tg-close-topic'), telegramReopenTopicOnReopen: checked('set-tg-reopen-topic'), telegramCleanupClosedTopics: checked('set-tg-cleanup'), telegramCleanupClosedHours: num('set-tg-cleanup-hours'),
    telegramTopicNameTemplate: val('set-topic-template'), telegramNewEmoji: val('set-emoji-new'), telegramOpenEmoji: val('set-emoji-open'), telegramWaitEmoji: val('set-emoji-wait'), telegramClosedEmoji: val('set-emoji-closed'), telegramCloseButtonText: val('set-close-btn'), telegramReopenButtonText: val('set-reopen-btn'),
    telegramNewTicketText: val('set-tg-new-ticket'), telegramClosedByUserText: val('set-tg-closed-user'), telegramClosedBySupportText: val('set-tg-closed-support'), telegramReopenedText: val('set-tg-reopened'), telegramReopenedByUserText: val('set-tg-reopened-user'), telegramAutoCloseText: val('set-tg-autoclose'), telegramWarnInactivityText: val('set-tg-warn'), telegramTopicDeletedAdminText: val('set-tg-topic-deleted')
  };
  socket.emit('admin_update_settings', payload);
  toast('Настройки сохранены', 'ok');
}

function renderTemplates() { $('templates').innerHTML = `<div class="section"><h2>Шаблоны ответов</h2><p>Шаблоны хранятся в браузере оператора и доступны в чате по кнопке #.</p><div class="card"><div id="tpl-list" class="template-list"></div><button id="tpl-add" class="add">Добавить шаблон</button><button id="tpl-reset" class="ghost" style="margin-left:8px">Вернуть стандартные</button></div></div>`; renderTemplateRows(); $('tpl-add').addEventListener('click', () => { S.templates.push({ label: 'Новый', text: '' }); saveTemplates(); renderTemplateRows(); }); $('tpl-reset').addEventListener('click', () => { S.templates = DEFAULT_TEMPLATES.slice(); saveTemplates(); renderTemplateRows(); toast('Шаблоны восстановлены', 'ok'); }); }
function renderTemplateRows() { const list = $('tpl-list'); if (!list) return; list.innerHTML = S.templates.map((t, i) => `<div class="tpl" data-i="${i}"><input class="tpl-label" value="${esc(t.label)}" placeholder="Название"><input class="tpl-text" value="${esc(t.text)}" placeholder="Текст ответа"><button title="Удалить">×</button></div>`).join('') || '<div class="empty">Шаблонов нет</div>'; list.querySelectorAll('.tpl').forEach(row => { const i = Number(row.dataset.i); row.querySelector('.tpl-label').addEventListener('input', e => { S.templates[i].label = e.target.value; saveTemplates(); }); row.querySelector('.tpl-text').addEventListener('input', e => { S.templates[i].text = e.target.value; saveTemplates(); }); row.querySelector('button').addEventListener('click', () => { S.templates.splice(i, 1); saveTemplates(); renderTemplateRows(); }); }); }

init();
