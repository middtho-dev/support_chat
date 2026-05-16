'use strict';

(() => {
  const ticketMap = new Map();
  let currentTicket = null;
  let currentMessages = [];
  let activeSocket = null;

  const $ = id => document.getElementById(id);
  const esc = value => value == null ? '' : String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  const tagsArray = ticket => String(ticket?.admin_tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  const timeAgo = iso => {
    if (!iso) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (sec < 60) return 'сейчас';
    if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
    return `${Math.floor(sec / 86400)} д`;
  };
  const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'нет ответа';

  function injectStyles() {
    if ($('admin-enhance-style')) return;
    const style = document.createElement('style');
    style.id = 'admin-enhance-style';
    style.textContent = `
      .ticket{grid-template-columns:44px minmax(0,1fr) auto;align-items:center}
      .tagline{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
      .tag-chip{display:inline-flex;align-items:center;max-width:130px;height:21px;padding:0 8px;border:1px solid rgba(125,211,252,.22);border-radius:999px;background:rgba(14,165,233,.10);color:#bae6fd;font-size:11px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .ticket-meta{padding:13px 18px 14px;border-bottom:1px solid var(--line);background:linear-gradient(135deg,rgba(15,23,42,.78),rgba(2,132,199,.10));backdrop-filter:blur(18px);display:grid;gap:12px}
      .meta-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      .meta-pill{min-height:50px;border:1px solid rgba(148,163,184,.16);border-radius:14px;background:rgba(15,23,42,.52);padding:9px 11px;box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}
      .meta-pill b{display:block;color:#f8fafc;font-size:13px;line-height:1.25}
      .meta-pill span{display:block;margin-top:3px;color:var(--muted);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em}
      .meta-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr) auto;gap:10px;align-items:end}
      .meta-field{display:grid;gap:6px;min-width:0}
      .meta-field label{font-size:11px;font-weight:900;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
      .meta-field input,.meta-field textarea,.tpl-search{width:100%;border:1px solid rgba(148,163,184,.18);background:rgba(2,6,23,.42);color:var(--text);border-radius:13px;padding:10px 12px;outline:none}
      .meta-field textarea{resize:vertical;min-height:42px;max-height:120px}
      .meta-save{height:42px;border:0;border-radius:13px;background:linear-gradient(135deg,var(--blue),var(--blue2));color:#041018;font-weight:900;padding:0 15px;box-shadow:0 12px 30px rgba(37,99,235,.24);cursor:pointer}
      .preset-tags{display:flex;gap:7px;flex-wrap:wrap}
      .preset-tags button{border:1px solid rgba(148,163,184,.16);background:rgba(255,255,255,.05);color:#dbeafe;border-radius:999px;padding:7px 10px;font-size:12px;font-weight:850;cursor:pointer}
      .tpl-search{height:38px;margin-bottom:8px}
      @media (max-width:760px){.ticket-meta{padding:12px}.meta-row,.meta-fields{grid-template-columns:1fr}.meta-save{width:100%}}
    `;
    document.head.appendChild(style);
  }

  function ensureMetaPanel() {
    let el = $('ticket-meta');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'ticket-meta';
    el.className = 'ticket-meta';
    const chat = $('chat');
    const messages = $('cv-msgs');
    if (chat && messages) chat.insertBefore(el, messages);
    return el;
  }

  function renderTicketMeta() {
    if (!currentTicket) return;
    const el = ensureMetaPanel();
    const firstResponse = currentMessages.find(message => message.sender === 'support');
    const pending = currentTicket.status === 'open' && (currentTicket.unread_count > 0 || currentTicket.last_sender === 'user');
    el.innerHTML = `
      <div class="meta-row">
        <div class="meta-pill"><b>${esc(pending ? 'Ждет ответа' : 'На контроле')}</b><span>Статус</span></div>
        <div class="meta-pill"><b>${esc(timeAgo(currentTicket.last_activity || currentTicket.created_at))}</b><span>Последняя активность</span></div>
        <div class="meta-pill"><b>${esc(firstResponse ? fmtTime(firstResponse.created_at) : 'нет ответа')}</b><span>Первый ответ</span></div>
      </div>
      <div class="meta-fields">
        <div class="meta-field"><label>Метки через запятую</label><input id="meta-tags" maxlength="180" value="${esc(tagsArray(currentTicket).join(', '))}" placeholder="vpn, оплата, срочно"></div>
        <div class="meta-field"><label>Внутренняя заметка</label><textarea id="meta-note" maxlength="1200" rows="1" placeholder="Видно только оператору">${esc(currentTicket.admin_note || '')}</textarea></div>
        <button id="meta-save" class="meta-save">Сохранить</button>
      </div>
      <div class="preset-tags">
        ${['срочно','оплата','vpn','ios','android','роутер','ждет клиента'].map(tag => `<button type="button" data-tag-preset="${esc(tag)}">${esc(tag)}</button>`).join('')}
      </div>`;
    $('meta-save')?.addEventListener('click', saveTicketMeta);
    el.querySelectorAll('[data-tag-preset]').forEach(btn => btn.addEventListener('click', () => addPresetTag(btn.dataset.tagPreset)));
  }

  function addPresetTag(tag) {
    const input = $('meta-tags');
    if (!input || !tag) return;
    const tags = String(input.value || '').split(',').map(item => item.trim()).filter(Boolean);
    if (!tags.some(item => item.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    input.value = tags.join(', ');
    input.focus();
  }

  function saveTicketMeta() {
    if (!activeSocket || !currentTicket) return;
    activeSocket.emit('admin_update_ticket_meta', {
      ticketId: currentTicket.id,
      tags: $('meta-tags')?.value || '',
      note: $('meta-note')?.value || ''
    });
  }

  function decorateTickets() {
    document.querySelectorAll('.ticket[data-id]').forEach(button => {
      const ticket = ticketMap.get(button.dataset.id);
      const tags = tagsArray(ticket).slice(0, 2);
      const signature = tags.join('|');
      if (button.dataset.tagSignature === signature) return;
      button.dataset.tagSignature = signature;
      button.querySelector('.tagline')?.remove();
      if (!tags.length) return;
      const content = button.children[1];
      if (!content) return;
      content.insertAdjacentHTML('beforeend', `<div class="tagline">${tags.map(tag => `<span class="tag-chip">${esc(tag)}</span>`).join('')}</div>`);
    });
  }

  function enhanceTemplatePicker(pop) {
    if (!pop || pop.dataset.enhancedTemplates) return;
    const buttons = [...pop.querySelectorAll('button')];
    if (!buttons.length) return;
    pop.dataset.enhancedTemplates = '1';
    const search = document.createElement('input');
    search.className = 'tpl-search';
    search.type = 'search';
    search.placeholder = 'Найти шаблон';
    pop.insertBefore(search, pop.firstChild);
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      buttons.forEach(button => {
        button.style.display = !q || button.textContent.toLowerCase().includes(q) ? '' : 'none';
      });
    });
    setTimeout(() => search.focus(), 0);
  }

  function observeDom() {
    const observer = new MutationObserver(() => {
      decorateTickets();
      document.querySelectorAll('.pop').forEach(enhanceTemplatePicker);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function wrapSocketFactory() {
    const originalIo = window.io;
    if (typeof originalIo !== 'function' || originalIo.__adminEnhanced) return;
    window.io = function enhancedIo(...args) {
      const socket = originalIo.apply(this, args);
      activeSocket = socket;
      const originalOn = socket.on.bind(socket);
      socket.on = (name, callback) => originalOn(name, payload => {
        callback(payload);
        setTimeout(() => handleSocketEvent(name, payload), 0);
      });
      return socket;
    };
    window.io.__adminEnhanced = true;
  }

  function handleSocketEvent(name, payload) {
    if (name === 'admin_tickets' && Array.isArray(payload)) {
      payload.forEach(ticket => ticketMap.set(ticket.id, ticket));
      decorateTickets();
    }
    if (name === 'admin_ticket_messages') {
      currentTicket = payload.ticket;
      currentMessages = Array.isArray(payload.messages) ? payload.messages : [];
      ticketMap.set(currentTicket.id, currentTicket);
      renderTicketMeta();
      decorateTickets();
    }
    if ((name === 'admin_ticket_meta' || name === 'admin_ticket_updated') && payload?.id) {
      const merged = { ...(ticketMap.get(payload.id) || {}), ...payload };
      ticketMap.set(payload.id, merged);
      if (currentTicket?.id === payload.id) {
        currentTicket = { ...currentTicket, ...payload };
        renderTicketMeta();
      }
      decorateTickets();
    }
  }

  injectStyles();
  wrapSocketFactory();
  observeDom();
})();
