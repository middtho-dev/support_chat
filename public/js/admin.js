'use strict';

const DEFAULT_TEMPLATES = [
  { label: 'Приветствие', text: 'Добрый день! Чем могу помочь?' },
  { label: 'Ожидание', text: 'Уточняю информацию, вернусь к вам в ближайшее время.' },
  { label: 'Переустановка', text: 'Попробуйте переустановить VPN-клиент и перезагрузить устройство.' },
  { label: 'Смена сервера', text: 'Попробуйте сменить сервер в настройках приложения.' },
  { label: 'Скриншот', text: 'Пришлите, пожалуйста, скриншот ошибки — это ускорит решение.' },
  { label: 'Тех. отдел', text: 'Ваш запрос передан техническому отделу. Ожидайте ответа.' },
  { label: 'Решено?', text: 'Удалось решить проблему? Если остались вопросы — пишите!' },
  { label: 'Завершение', text: 'Спасибо за обращение в поддержку KV9RU! Будем рады помочь снова.' }
];
const COLORS = ['#2563eb','#7c3aed','#db2777','#dc2626','#d97706','#059669','#0891b2','#9333ea'];
const S = { token: null, tickets: [], filter: 'open', search: '', current: null, messages: [], settings: null, templates: loadTemplates(), view: 'chat', lastDate: '' };
const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

const esc = value => value == null ? '' : String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
const linkify = value => value.replace(/https?:\/\/[^\s<>"']+/g, url => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`);
const fmtTime = date => date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDate = date => date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
function timeAgo(iso) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return 'сейчас';
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
  return `${Math.floor(sec / 86400)} д`;
}
function avatarColor(name = '') { let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffff; return COLORS[h % COLORS.length]; }
function initials(name = '') { return (name.trim() || '?').slice(0, 2).toUpperCase(); }
function loadTemplates() { try { return JSON.parse(localStorage.getItem('admin_templates')) || DEFAULT_TEMPLATES; } catch { return DEFAULT_TEMPLATES; } }
function saveTemplates() { localStorage.setItem('admin_templates', JSON.stringify(S.templates)); }
let toastTimer;
function toast(text, type = 'info') { const el = $('toast'); clearTimeout(toastTimer); el.textContent = text; el.style.borderColor = type === 'err' ? 'rgba(251,113,133,.45)' : type === 'ok' ? 'rgba(52,211,153,.45)' : ''; el.classList.add('on'); toastTimer = setTimeout(() => el.classList.remove('on'), 2800); }

function setConn(state) {
  $('cdot').className = `dot ${state}`;
  $('ctxt').textContent = state === 'on' ? 'онлайн' : state === 'off' ? 'нет соединения' : 'подключение';
}

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
  $('reply-txt').addEventListener('input', onReplyInput);
  $('reply-txt').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendReply(); } });
  $('reply-send').addEventListener('click', sendReply);
  $('quick').addEventListener('click', showTemplatePicker);
  document.addEventListener('click', event => { if (!event.target.closest('.pop') && event.target !== $('quick')) document.querySelectorAll('.pop').forEach(p => p.remove()); });
}

function login() {
  const token = $('tok').value.trim();
  if (!token) return;
  S.token = token;
  $('lbtn').disabled = true;
  $('lerr').textContent = '';
  setConn('');
  socket.connect();
}
function logout() {
  sessionStorage.removeItem('admin_token');
  socket.disconnect();
  S.token = null; S.tickets = []; S.current = null; S.messages = [];
  $('app').style.display = 'none'; $('login').style.display = 'grid'; $('tok').value = ''; $('lbtn').disabled = false; setConn('off');
}

socket.on('connect', () => { setConn('on'); if (S.token) socket.emit('admin_auth', { token: S.token }); });
socket.on('disconnect', () => setConn('off'));
socket.io.on('reconnect_attempt', () => setConn(''));
socket.on('admin_auth_ok', () => { sessionStorage.setItem('admin_token', S.token); $('login').style.display = 'none'; $('app').style.display = 'grid'; $('lbtn').disabled = false; socket.emit('admin_get_settings'); });
socket.on('admin_auth_error', () => { $('lbtn').disabled = false; $('lerr').textContent = 'Неверный токен доступа'; sessionStorage.removeItem('admin_token'); socket.disconnect(); setConn('off'); });
socket.on('admin_settings', settings => { S.settings = settings; renderSettings(); });
socket.on('admin_tickets', tickets => { S.tickets = tickets || []; renderSidebar(); });
socket.on('admin_new_ticket', ticket => { S.tickets = [ticket, ...S.tickets.filter(t => t.id !== ticket.id)]; renderSidebar(); toast('Новая заявка', 'ok'); });
socket.on('admin_ticket_messages', ({ ticketId, messages, ticket }) => { if (ticketId !== S.current?.id) return; S.current = ticket; S.messages = messages || []; renderConversation(); renderChatHeader(); });
socket.on('admin_ticket_status', ({ ticketId, status }) => { const t = S.tickets.find(x => x.id === ticketId); if (t) t.status = status; if (S.current?.id === ticketId) { S.current.status = status; renderChatHeader(); } renderSidebar(); });
socket.on('admin_new_message', ({ ticketId, message }) => {
  const t = S.tickets.find(x => x.id === ticketId);
  if (t) { t.last_msg = message.content; t.last_sender = message.sender; t.last_msg_type = message.message_type; t.last_activity = message.created_at; if (message.sender === 'user' && ticketId !== S.current?.id) t.unread_count = (t.unread_count || 0) + 1; }
  if (ticketId === S.current?.id) { S.messages.push(message); appendMessage(message); scrollBottom(true); }
  renderSidebar();
});
socket.on('admin_user_typing', ({ ticketId }) => { if (ticketId !== S.current?.id) return; const el = $('typing'); el.style.display = 'block'; clearTimeout(el._timer); el._timer = setTimeout(() => el.style.display = 'none', 2600); });
socket.on('admin_error', ({ message }) => toast(message || 'Ошибка', 'err'));

function setView(view) {
  S.view = view;
  document.querySelectorAll('.navbtn').forEach(btn => btn.classList.toggle('on', btn.dataset.view === view));
  if (view === 'chat') { $('side').style.display = ''; $('welcome').style.display = S.current ? 'none' : 'grid'; $('chat').style.display = S.current ? 'flex' : 'none'; $('settings').classList.remove('on'); $('templates').classList.remove('on'); }
  if (view === 'settings') { $('side').style.display = 'none'; $('welcome').style.display = 'none'; $('chat').style.display = 'none'; $('templates').classList.remove('on'); $('settings').classList.add('on'); $('main').classList.add('open'); }
  if (view === 'templates') { $('side').style.display = 'none'; $('welcome').style.display = 'none'; $('chat').style.display = 'none'; $('settings').classList.remove('on'); $('templates').classList.add('on'); $('main').classList.add('open'); }
}
function setFilter(filter) { S.filter = filter; document.querySelectorAll('.tab').forEach(btn => btn.classList.toggle('on', btn.dataset.tab === filter)); renderSidebar(); }

function renderSidebar() {
  const open = S.tickets.filter(t => t.status === 'open').length;
  const unread = S.tickets.reduce((sum, t) => sum + (t.status === 'open' && t.unread_count ? 1 : 0), 0);
  $('m-open').textContent = open; $('m-unread').textContent = unread; $('m-all').textContent = S.tickets.length;
  const list = $('tlist');
  const items = S.tickets.filter(t => {
    if (S.filter !== 'all' && t.status !== S.filter) return false;
    if (!S.search) return true;
    return `${t.user_name} ${t.id}`.toLowerCase().includes(S.search);
  });
  if (!items.length) { list.innerHTML = `<div class="empty">${S.search ? 'Ничего не найдено' : 'Заявок в этом разделе нет'}</div>`; return; }
  list.innerHTML = items.map(t => ticketHtml(t)).join('');
  list.querySelectorAll('.ticket').forEach(el => el.addEventListener('click', () => openTicket(el.dataset.id)));
}
function ticketHtml(t) {
  const wait = t.unread_count > 0 ? 'wait' : '';
  const closed = t.status === 'closed' ? 'closed' : '';
  const ts = t.last_activity || t.created_at;
  const badge = t.unread_count > 0 ? `<div class="badge">${t.unread_count}</div>` : '';
  return `<button class="ticket ${S.current?.id === t.id ? 'on' : ''}" data-id="${esc(t.id)}">
    <div class="avatar ${closed || wait}" style="background:${avatarColor(t.user_name)}">${esc(initials(t.user_name))}</div>
    <div><div class="tname">${esc(t.user_name)}</div><div class="tlast">${preview(t)}</div></div>
    <div><div class="time" data-ts="${esc(ts)}">${timeAgo(ts)}</div>${badge}</div>
  </button>`;
}
function preview(t) {
  if (!t.last_msg && !t.last_msg_type) return '<span>нет сообщений</span>';
  const prefix = t.last_sender === 'support' ? 'Вы: ' : '';
  if (t.last_msg_type && t.last_msg_type !== 'text') return esc(prefix + (t.last_msg_type === 'image' ? 'Фото' : t.last_msg_type === 'video' ? 'Видео' : t.last_msg_type === 'audio' ? 'Аудио' : 'Файл'));
  return esc(prefix + (t.last_msg || '').slice(0, 80));
}
function renderRelativeTimes() { document.querySelectorAll('[data-ts]').forEach(el => { el.textContent = timeAgo(el.dataset.ts); }); }

function openTicket(id) {
  const ticket = S.tickets.find(t => t.id === id);
  if (!ticket) return;
  S.current = ticket; S.current.unread_count = 0; S.messages = []; S.lastDate = '';
  setView('chat'); $('main').classList.add('open'); $('welcome').style.display = 'none'; $('chat').style.display = 'flex'; $('cv-msgs').innerHTML = '<div class="empty">Загрузка сообщений...</div>';
  renderSidebar(); renderChatHeader(); socket.emit('admin_open_ticket', { ticketId: id });
}
function renderChatHeader() {
  if (!S.current) return;
  const t = S.current;
  $('cv-av').style.background = avatarColor(t.user_name); $('cv-av').textContent = initials(t.user_name); $('cv-av').className = `avatar ${t.status === 'closed' ? 'closed' : ''}`;
  $('cv-name').textContent = t.user_name;
  $('cv-sub').textContent = `#${t.id.slice(0, 8)} · ${fmtDate(new Date(t.created_at))} · ${t.status === 'open' ? 'открыто' : 'закрыто'}`;
  const btn = $('cv-toggle'); btn.disabled = !!t.telegram_topic_deleted; btn.className = t.status === 'open' ? 'danger' : 'okbtn'; btn.textContent = t.status === 'open' ? 'Закрыть' : (t.telegram_topic_deleted ? 'Тема удалена' : 'Переоткрыть');
  $('composer').innerHTML = t.status === 'open' ? composerHtml() : '<div class="closed-note">Обращение закрыто. При необходимости переоткройте его.</div>';
  if (t.status === 'open') wireComposer();
}
function composerHtml() { return `<div class="compose-row"><button id="quick" class="quick" title="Шаблоны">#</button><textarea id="reply-txt" rows="1" placeholder="Ответ оператора..."></textarea><button id="reply-send" class="send" disabled>➤</button></div><div class="hint"><span>Ctrl+Enter — отправить</span><span id="reply-cnt"></span></div>`; }
function wireComposer() { $('reply-txt').addEventListener('input', onReplyInput); $('reply-txt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } }); $('reply-send').addEventListener('click', sendReply); $('quick').addEventListener('click', showTemplatePicker); }
function renderConversation() { const box = $('cv-msgs'); box.innerHTML = ''; S.lastDate = ''; if (!S.messages.length) { box.innerHTML = '<div class="empty">Сообщений пока нет</div>'; return; } S.messages.forEach(m => appendMessage(m, false)); scrollBottom(false); }
function appendMessage(msg, scroll = false) {
  const box = $('cv-msgs'); if (!box) return; const empty = box.querySelector('.empty'); if (empty) empty.remove();
  if (msg.sender !== 'system') { const ds = fmtDate(new Date(msg.created_at)); if (ds !== S.lastDate) { S.lastDate = ds; box.insertAdjacentHTML('beforeend', `<div class="day">${esc(ds)}</div>`); } }
  const out = msg.sender === 'support'; const sys = msg.sender === 'system';
  const sender = !out && !sys ? `<div class="sender">${esc(msg.sender_name || 'Клиент')}</div>` : '';
  box.insertAdjacentHTML('beforeend', `<div class="msg ${sys ? 'sys' : out ? 'out' : 'in'}"><div class="bubble">${sender}${messageBody(msg)}<div class="meta">${fmtTime(new Date(msg.created_at))}</div></div></div>`);
  if (scroll) scrollBottom(true);
}
function messageBody(msg) {
  const text = msg.content ? `<div>${linkify(esc(msg.content))}</div>` : '';
  if (msg.message_type === 'image' && msg.file_url) return `<img src="${esc(msg.file_url)}" loading="lazy">${text}`;
  if (msg.message_type === 'video' && msg.file_url) return `<video src="${esc(msg.file_url)}" controls preload="metadata"></video>${text}`;
  if (msg.message_type === 'audio' && msg.file_url) return `<audio src="${esc(msg.file_url)}" controls></audio>${text}`;
  if (msg.file_url) return `<a class="file" href="${esc(msg.file_url)}" target="_blank" rel="noopener noreferrer" download="${esc(msg.file_name || 'file')}"><span class="file-ico">↧</span><span>${esc(msg.file_name || 'Файл')}</span></a>${text}`;
  return text || '<span></span>';
}
function scrollBottom(smooth) { const box = $('cv-msgs'); requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })); }
function onReplyInput() { const txt = $('reply-txt'), send = $('reply-send'), cnt = $('reply-cnt'); if (!txt || !send) return; txt.style.height = 'auto'; txt.style.height = `${Math.min(txt.scrollHeight, 140)}px`; send.disabled = !txt.value.trim(); if (cnt) cnt.textContent = txt.value ? `${txt.value.length} симв.` : ''; socket.emit('admin_typing', { ticketId: S.current?.id }); }
function sendReply() { const txt = $('reply-txt'); if (!txt || !S.current || S.current.status !== 'open') return; const content = txt.value.trim(); if (!content) return; txt.value = ''; txt.style.height = 'auto'; $('reply-send').disabled = true; $('reply-cnt').textContent = ''; socket.emit('admin_reply', { ticketId: S.current.id, content }); }
function toggleTicketStatus() { if (!S.current) return; socket.emit(S.current.status === 'open' ? 'admin_close_ticket' : 'admin_reopen_ticket', { ticketId: S.current.id }); }

function showTemplatePicker(event) {
  event.stopPropagation(); document.querySelectorAll('.pop').forEach(p => p.remove());
  const pop = document.createElement('div'); pop.className = 'pop';
  pop.innerHTML = S.templates.map((t, i) => `<button data-i="${i}"><b>${esc(t.label)}</b><span>${esc(t.text)}</span></button>`).join('') || '<div class="empty">Шаблонов нет</div>';
  document.body.appendChild(pop); const r = $('quick').getBoundingClientRect(); pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 12)}px`; pop.style.top = `${Math.max(74, r.top - pop.offsetHeight - 10)}px`;
  pop.querySelectorAll('button').forEach(btn => btn.addEventListener('click', () => { const item = S.templates[Number(btn.dataset.i)]; const txt = $('reply-txt'); txt.value = item.text; txt.dispatchEvent(new Event('input')); txt.focus(); pop.remove(); }));
}

function renderSettings() {
  const s = S.settings || { workStartHour: 8, workEndHour: 23, offhoursEnabled: true, offhoursBannerText: '', offhoursRejectText: '' };
  $('settings').innerHTML = `<div class="section"><h2>Настройки функций</h2><p>Эти параметры сервер применяет сразу после сохранения.</p><div class="grid"><div class="card"><h3>Рабочий график</h3><div class="field"><label>Часовой пояс</label><input id="set-tz" value="${esc(s.timezone || 'Europe/Moscow')}" disabled></div><div class="grid"><div class="field"><label>Начало</label><input id="set-work-start" type="number" min="0" max="23" value="${esc(s.workStartHour ?? 8)}"></div><div class="field"><label>Конец</label><input id="set-work-end" type="number" min="1" max="24" value="${esc(s.workEndHour ?? 23)}"></div></div><label class="check"><input id="set-offhours-enabled" type="checkbox" ${s.offhoursEnabled ? 'checked' : ''}> Блокировать новые сообщения вне графика</label></div><div class="card"><h3>Тексты вне графика</h3><div class="field"><label>Баннер в чате</label><textarea id="set-banner-text">${esc(s.offhoursBannerText || '')}</textarea></div><div class="field"><label>Ответ при попытке написать</label><textarea id="set-reject-text">${esc(s.offhoursRejectText || '')}</textarea></div></div></div><button id="set-save" class="save">Сохранить настройки</button></div>`;
  $('set-save').addEventListener('click', saveSettings);
}
function saveSettings() { socket.emit('admin_update_settings', { workStartHour: Number($('set-work-start').value || 8), workEndHour: Number($('set-work-end').value || 23), offhoursEnabled: $('set-offhours-enabled').checked, offhoursBannerText: $('set-banner-text').value.trim(), offhoursRejectText: $('set-reject-text').value.trim() }); toast('Настройки сохранены', 'ok'); }

function renderTemplates() {
  $('templates').innerHTML = `<div class="section"><h2>Шаблоны ответов</h2><p>Шаблоны хранятся в браузере оператора и доступны в чате по кнопке #.</p><div class="card"><div id="tpl-list" class="template-list"></div><button id="tpl-add" class="add">Добавить шаблон</button><button id="tpl-reset" class="ghost" style="margin-left:8px">Вернуть стандартные</button></div></div>`;
  renderTemplateRows(); $('tpl-add').addEventListener('click', () => { S.templates.push({ label: 'Новый', text: '' }); saveTemplates(); renderTemplateRows(); }); $('tpl-reset').addEventListener('click', () => { S.templates = DEFAULT_TEMPLATES.slice(); saveTemplates(); renderTemplateRows(); toast('Шаблоны восстановлены', 'ok'); });
}
function renderTemplateRows() {
  const list = $('tpl-list'); if (!list) return;
  list.innerHTML = S.templates.map((t, i) => `<div class="tpl" data-i="${i}"><input class="tpl-label" value="${esc(t.label)}" placeholder="Название"><input class="tpl-text" value="${esc(t.text)}" placeholder="Текст ответа"><button title="Удалить">×</button></div>`).join('') || '<div class="empty">Шаблонов нет</div>';
  list.querySelectorAll('.tpl').forEach(row => { const i = Number(row.dataset.i); row.querySelector('.tpl-label').addEventListener('input', e => { S.templates[i].label = e.target.value; saveTemplates(); }); row.querySelector('.tpl-text').addEventListener('input', e => { S.templates[i].text = e.target.value; saveTemplates(); }); row.querySelector('button').addEventListener('click', () => { S.templates.splice(i, 1); saveTemplates(); renderTemplateRows(); }); });
}

init();
