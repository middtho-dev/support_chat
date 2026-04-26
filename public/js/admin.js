'use strict';

const CANNED = [
  { label: 'Приветствие',    text: 'Добрый день! Чем могу помочь?' },
  { label: 'Ожидание',       text: 'Уточняю информацию, вернусь к вам в ближайшее время.' },
  { label: 'Переустановка',  text: 'Попробуйте переустановить VPN-клиент и перезагрузить устройство.' },
  { label: 'Смена сервера',  text: 'Попробуйте сменить сервер в настройках приложения.' },
  { label: 'Скриншот',       text: 'Пришлите, пожалуйста, скриншот ошибки — это ускорит решение.' },
  { label: 'Тех. отдел',     text: 'Ваш запрос передан техническому отделу. Ожидайте ответа.' },
  { label: 'Решено?',        text: 'Удалось решить проблему? Если остались вопросы — пишите!' },
  { label: 'Завершение',     text: 'Спасибо за обращение в поддержку KV9RU! Будем рады помочь снова.' },
];

const AVATAR_COLORS = ['#2563eb','#7c3aed','#db2777','#dc2626','#d97706','#059669','#0891b2','#9333ea'];

const S = {
  token: null,
  tickets: [],
  filter: 'open',
  search: '',
  current: null,   // current ticket object
  lastDate: null,
  lastTyping: 0,
};

const socket = io({ autoConnect: false });
const $ = id => document.getElementById(id);

// ── Utilities ──────────────────────────────────────────────────────────────

const esc = s => s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
const linkify = t => t.replace(/(https?:\/\/[^\s<>"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
const fmtTime = d => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function fmtDate(d) {
  const n = new Date(), td = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  const diff = Math.round((td - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин';
  if (s < 86400) return Math.floor(s / 3600) + ' ч';
  return Math.floor(s / 86400) + ' д';
}
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name) { return name.trim().slice(0, 2).toUpperCase(); }
function dico() {
  return `<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="1.5" y="1" width="12" height="13" rx="2"/><path d="M4 5h7M4 8h7M4 11h4"/></svg>`;
}

let toastTimer;
function toast(msg, type = '') {
  const el = $('tst');
  clearTimeout(toastTimer);
  const icon = type === 'ok' ? '✓' : type === 'err' ? '✗' : 'ℹ';
  const color = type === 'ok' ? 'var(--green)' : type === 'err' ? 'var(--red)' : 'var(--blue)';
  el.innerHTML = `<span style="color:${color};font-weight:700">${icon}</span><span>${esc(msg)}</span>`;
  el.classList.add('on');
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

// Ripple on buttons
document.addEventListener('pointerdown', e => {
  const btn = e.target.closest('.rbtn,.lbtn,.tbtn,.cv-toggle,.sb-tab');
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const span = document.createElement('span');
  span.className = 'rpl';
  const size = Math.max(r.width, r.height);
  span.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX-r.left-size/2}px;top:${e.clientY-r.top-size/2}px`;
  btn.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
}, { passive: true });

// ── Connection status ──────────────────────────────────────────────────────

function setConn(s) {
  const dot = $('cdot'), txt = $('ctxt');
  dot.className = 'tb-dot ' + s;
  txt.textContent = s === 'on' ? 'онлайн' : s === 'connecting' ? 'подключение...' : 'нет соединения';
}

// ── Auth ───────────────────────────────────────────────────────────────────

function init() {
  buildCanned();
  startTimeAgoRefresh();
  const saved = sessionStorage.getItem('admin_token');
  if (saved) { S.token = saved; setConn('connecting'); socket.connect(); }
  else setTimeout(() => $('tok').focus(), 120);
}

$('lbtn').addEventListener('click', doLogin);
$('tok').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

function doLogin() {
  const tok = $('tok').value.trim();
  if (!tok) return;
  $('lbtn').disabled = true;
  $('lerr').textContent = '';
  S.token = tok;
  setConn('connecting');
  socket.connect();
}

$('logout-btn').addEventListener('click', () => {
  sessionStorage.removeItem('admin_token');
  S.token = null;
  socket.disconnect();
  $('app').style.display = 'none';
  $('login').style.display = 'flex';
  $('tok').value = '';
  $('lbtn').disabled = false;
  S.current = null;
  S.tickets = [];
});

// ── Socket events ──────────────────────────────────────────────────────────

socket.on('connect', () => {
  setConn('on');
  if (S.token) socket.emit('admin_auth', { token: S.token });
});

socket.on('disconnect', () => setConn('off'));
socket.io.on('reconnect_attempt', () => setConn('connecting'));

socket.on('admin_auth_ok', () => {
  sessionStorage.setItem('admin_token', S.token);
  $('login').style.display = 'none';
  $('app').style.display = 'flex';
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
  if (ticketId === S.current?.id) appendMsg(message);
});

socket.on('admin_ticket_messages', ({ ticketId, messages, ticket }) => {
  if (ticketId !== S.current?.id) return;
  S.current = ticket;
  renderConversation(messages);
  updateCvHeader();
});

socket.on('admin_ticket_status', ({ ticketId, status }) => {
  const t = S.tickets.find(t => t.id === ticketId);
  if (t) t.status = status;
  renderSidebar();
  if (ticketId === S.current?.id) {
    S.current.status = status;
    updateCvHeader();
  }
});

socket.on('admin_error', ({ message }) => toast(message, 'err'));

// User typing (forwarded from socket room via ticket:id room — admin doesn't join those)
// We detect user activity from admin_new_message and don't show typing in admin (complex)

// ── Sidebar ────────────────────────────────────────────────────────────────

$('srch').addEventListener('input', () => { S.search = $('srch').value.trim().toLowerCase(); renderSidebar(); });

document.querySelectorAll('.sb-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sb-tab').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    S.filter = btn.dataset.tab;
    renderSidebar();
  });
});

function renderSidebar() {
  const list = $('tlist');
  let items = S.tickets.filter(t => {
    if (S.filter === 'open'   && t.status !== 'open')   return false;
    if (S.filter === 'closed' && t.status !== 'closed') return false;
    if (S.search && !t.user_name.toLowerCase().includes(S.search)) return false;
    return true;
  });

  // Stats (always over all tickets)
  const open  = S.tickets.filter(t => t.status === 'open').length;
  const newMsg = S.tickets.filter(t => t.status === 'open' && (t.unread_count || 0) > 0).length;
  $('ocnt').textContent = open;
  $('ncnt').textContent = newMsg;

  if (!items.length) {
    list.innerHTML = `<div class="t-empty">${S.search ? 'Ничего не найдено' : S.filter === 'open' ? 'Открытых обращений нет' : 'Нет обращений'}</div>`;
    return;
  }

  list.innerHTML = '';
  items.forEach(t => {
    const div = document.createElement('div');
    div.className = 'ti' + (S.current?.id === t.id ? ' active' : '');
    div.dataset.id = t.id;

    const col   = avatarColor(t.user_name);
    const init  = initials(t.user_name);
    const dotCls = t.status === 'closed' ? 'closed' : (t.unread_count > 0 ? 'wait' : 'open');
    const ago   = timeAgo(t.last_activity || t.created_at);
    const badge = t.unread_count > 0 ? `<div class="ti-badge">${t.unread_count}</div>` : '';
    const pre   = msgPreview(t);

    div.innerHTML = `
      <div class="ti-av" style="background:${col}">${esc(init)}
        <div class="ti-dot ${dotCls}"></div>
      </div>
      <div class="ti-body">
        <div class="ti-name">${esc(t.user_name)}</div>
        <div class="ti-last">${pre}</div>
      </div>
      <div class="ti-meta">
        <div class="ti-time">${ago}</div>
        ${badge}
      </div>`;
    div.addEventListener('click', () => openTicket(t.id));
    list.appendChild(div);
  });
}

function msgPreview(t) {
  if (!t.last_msg && !t.last_msg_type) return '<span style="color:var(--t3);font-style:italic">нет сообщений</span>';
  const sender = t.last_sender === 'support' ? '<span style="color:var(--t3)">Вы: </span>' : '';
  const body = (t.last_msg_type && t.last_msg_type !== 'text')
    ? `📎 ${t.last_msg_type === 'image' ? 'Фото' : t.last_msg_type === 'video' ? 'Видео' : 'Файл'}`
    : esc((t.last_msg || '').slice(0, 55));
  return sender + body;
}

// ── Open ticket ────────────────────────────────────────────────────────────

function openTicket(id) {
  S.current = S.tickets.find(t => t.id === id) || null;
  if (!S.current) return;

  S.current.unread_count = 0;
  renderSidebar();

  document.body.classList.add('ticket-open');
  $('mempty').style.display = 'none';
  $('cv').style.display = 'flex';
  S.lastDate = null;

  const box = $('cv-msgs');
  box.innerHTML = '<div style="display:flex;justify-content:center;padding:24px"><div class="sp"></div></div>';

  socket.emit('admin_open_ticket', { ticketId: id });
  updateCvHeader();
}

$('cv-back').addEventListener('click', () => {
  document.body.classList.remove('ticket-open');
});

// ── Conversation ───────────────────────────────────────────────────────────

function updateCvHeader() {
  const t = S.current;
  if (!t) return;
  const col = avatarColor(t.user_name);
  const av  = $('cv-av');
  av.style.background = col;
  av.textContent = initials(t.user_name);

  $('cv-name').textContent = t.user_name;
  const date = new Date(t.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  $('cv-sub').textContent = `#${t.id.slice(0, 8)} · ${date} · ${t.status === 'open' ? 'открыто' : 'закрыто'}`;

  const btn = $('cv-toggle');
  if (t.status === 'open') {
    btn.textContent = 'Закрыть';
    btn.className = 'cv-toggle close-btn';
  } else {
    btn.textContent = t.telegram_topic_deleted ? 'Тема удалена' : 'Переоткрыть';
    btn.className = 'cv-toggle reopen-btn';
    btn.disabled = !!t.telegram_topic_deleted;
  }

  const reply = $('reply-area');
  if (reply) {
    reply.className = t.status === 'open' ? 'reply' : 'reply closed-state';
    if (t.status !== 'open') {
      reply.innerHTML = '🔒 Обращение закрыто';
    } else {
      reply.innerHTML = `
        <div class="reply-row">
          <div class="canned-wrap">
            <button class="rbtn rbtn-canned" id="canned-btn" title="Быстрые ответы">
              <svg width="17" height="17" viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <path d="M2 4h13M2 8h9M2 12h6"/><circle cx="14" cy="12" r="2.5"/><path d="M14 10v1.5"/>
              </svg>
            </button>
            <div class="canned-pop" id="canned-pop">
              <div class="canned-hdr">Быстрые ответы</div>
            </div>
          </div>
          <textarea class="reply-txt" id="reply-txt" placeholder="Ответ оператора..." rows="1"></textarea>
          <button class="rbtn rbtn-send" id="reply-send" disabled>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 8L15 2.5 8.5 15l-.7-6L2 8z"/></svg>
          </button>
        </div>
        <div class="reply-hint">Ctrl+Enter — отправить</div>`;
      rebuildCannedPop();
      wireReply();
    }
  }
}

function renderConversation(messages) {
  const box = $('cv-msgs');
  box.innerHTML = '';
  S.lastDate = null;
  if (!messages.length) {
    box.innerHTML = '<div class="t-empty">Сообщений пока нет</div>';
    return;
  }
  messages.forEach(m => appendMsg(m, false));
  requestAnimationFrame(() => box.scrollTo({ top: box.scrollHeight, behavior: 'auto' }));
}

function appendMsg(msg, scroll = true) {
  const box = $('cv-msgs');
  if (!box) return;

  if (msg.sender === 'system') {
    const d = document.createElement('div');
    d.className = 'amsg sys';
    d.innerHTML = `<div class="abub"><span class="atxt">${esc(msg.content || '')}</span></div>`;
    box.appendChild(d);
    if (scroll) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    return;
  }

  const dt = new Date(msg.created_at);
  const ds = fmtDate(dt);
  if (ds !== S.lastDate) {
    S.lastDate = ds;
    const sep = document.createElement('div');
    sep.className = 'adsp';
    sep.innerHTML = `<span>${ds}</span>`;
    box.appendChild(sep);
  }

  const isOut = msg.sender === 'support';
  const div = document.createElement('div');
  div.className = 'amsg ' + (isOut ? 'o' : 'i');

  let h = '';
  if (!isOut) h += `<div class="asnm">${esc(msg.sender_name)}</div>`;
  h += '<div class="abub">';

  if (msg.reply_to_id) {
    const qname = esc(msg.reply_to_sender_name || '');
    const qt = (msg.reply_to_type && msg.reply_to_type !== 'text')
      ? (msg.reply_to_file_name ? `📎 ${esc(msg.reply_to_file_name)}` : '📎 Медиа')
      : esc((msg.reply_to_content || '').slice(0, 60));
    h += `<div class="qblock"><div class="qname">${qname}</div><div class="qtxt">${qt}</div></div>`;
  }

  if (msg.message_type === 'image' && msg.file_url) {
    h += `<img class="aimg" src="${esc(msg.file_url)}" loading="lazy" onclick="openLb(this)">`;
    if (msg.content) h += `<div class="atxt" style="margin-top:5px">${esc(msg.content)}</div>`;
  } else if (msg.message_type === 'video' && msg.file_url) {
    h += `<video class="avid" src="${esc(msg.file_url)}" controls preload="metadata"></video>`;
  } else if (msg.message_type === 'audio' && msg.file_url) {
    h += `<audio src="${esc(msg.file_url)}" controls style="max-width:200px;display:block;margin:2px 0"></audio>`;
  } else if (msg.file_url) {
    h += `<a class="afile" href="${esc(msg.file_url)}" download="${esc(msg.file_name||'file')}" target="_blank" rel="noopener noreferrer">
      <div class="afic">${dico()}</div>
      <div class="afnm">${esc(msg.file_name || 'Файл')}</div></a>`;
    if (msg.content) h += `<div class="atxt" style="margin-top:4px">${esc(msg.content)}</div>`;
  } else {
    h += `<div class="atxt">${linkify(esc(msg.content || ''))}</div>`;
  }

  h += `<div class="ameta"><span class="atime">${fmtTime(dt)}</span></div></div>`;
  div.innerHTML = h;
  box.appendChild(div);
  if (scroll) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}

// ── Reply ──────────────────────────────────────────────────────────────────

function wireReply() {
  const txt  = $('reply-txt');
  const send = $('reply-send');
  if (!txt || !send) return;

  txt.addEventListener('input', () => {
    txt.style.height = 'auto';
    txt.style.height = Math.min(txt.scrollHeight, 130) + 'px';
    send.disabled = !txt.value.trim();

    const now = Date.now();
    if (S.current?.status === 'open' && now - S.lastTyping > 4000) {
      S.lastTyping = now;
      socket.emit('admin_typing', { ticketId: S.current.id });
    }
  });

  txt.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doReply(); }
  });

  send.addEventListener('click', doReply);

  // Re-attach canned pop listener
  $('canned-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    $('canned-pop')?.classList.toggle('on');
  });
}

function doReply() {
  const txt  = $('reply-txt');
  const send = $('reply-send');
  if (!txt || !S.current || S.current.status !== 'open') return;
  const text = txt.value.trim();
  if (!text) return;
  send.disabled = true;
  txt.value = '';
  txt.style.height = 'auto';
  socket.emit('admin_reply', { ticketId: S.current.id, content: text });
}

// ── Close / Reopen ─────────────────────────────────────────────────────────

$('cv-toggle').addEventListener('click', () => {
  if (!S.current) return;
  if (S.current.status === 'open') {
    socket.emit('admin_close_ticket', { ticketId: S.current.id });
  } else {
    socket.emit('admin_reopen_ticket', { ticketId: S.current.id });
  }
});

// ── Canned responses ───────────────────────────────────────────────────────

function buildCanned() {
  // Initial build done in updateCvHeader → rebuildCannedPop each time reply is shown
}

function rebuildCannedPop() {
  const pop = $('canned-pop');
  if (!pop) return;
  pop.innerHTML = '<div class="canned-hdr">Быстрые ответы</div>';
  CANNED.forEach(cr => {
    const d = document.createElement('div');
    d.className = 'canned-item';
    d.innerHTML = `<div class="canned-lbl">${esc(cr.label)}</div><div class="canned-txt">${esc(cr.text)}</div>`;
    d.addEventListener('click', () => {
      const txt = $('reply-txt');
      if (txt) {
        txt.value = cr.text;
        txt.style.height = 'auto';
        txt.style.height = Math.min(txt.scrollHeight, 130) + 'px';
        $('reply-send').disabled = false;
        txt.focus();
      }
      pop.classList.remove('on');
    });
    pop.appendChild(d);
  });
}

document.addEventListener('click', () => {
  document.querySelectorAll('.canned-pop.on').forEach(p => p.classList.remove('on'));
});

// ── Lightbox ───────────────────────────────────────────────────────────────

window.openLb = img => {
  const lb = document.createElement('div');
  lb.className = 'lb';
  lb.innerHTML = `<img src="${img.src}">`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
};

// ── Time-ago refresh ───────────────────────────────────────────────────────

function startTimeAgoRefresh() {
  setInterval(() => {
    document.querySelectorAll('.ti-time[data-ts]').forEach(el => {
      el.textContent = timeAgo(el.dataset.ts);
    });
  }, 30000);
}

// ── Boot ───────────────────────────────────────────────────────────────────

init();
