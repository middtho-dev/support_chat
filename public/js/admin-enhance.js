'use strict';

(() => {
  const ticketMap = new Map();
  let currentTicket = null;
  let currentMessages = [];
  let activeSocket = null;
  let cardOpen = false;

  const $ = id => document.getElementById(id);
  const esc = value => value == null ? '' : String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
  const tagsArray = ticket => String(ticket?.admin_tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  const parseServerDate = value => {
    const raw = String(value || '');
    return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(' ', 'T')}Z`
      : raw);
  };
  const timeAgo = iso => {
    if (!iso) return '—';
    const sec = Math.max(0, Math.floor((Date.now() - parseServerDate(iso).getTime()) / 1000));
    if (sec < 60) return 'сейчас';
    if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
    return `${Math.floor(sec / 86400)} д`;
  };
  const fmtTime = iso => iso ? parseServerDate(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'нет ответа';
  const telegramProfile = ticket => {
    const id = String(ticket?.telegram_customer_id || '');
    const username = String(ticket?.telegram_customer_username || '').replace(/^@/, '');
    const validUsername = /^[a-zA-Z0-9_]{5,32}$/.test(username) ? username : '';
    return {
      id,
      username: validUsername,
      directUrl: id ? `tg://user?id=${encodeURIComponent(id)}` : '',
      profileUrl: validUsername ? `https://t.me/${validUsername}` : ''
    };
  };

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
    const activityAge = timeAgo(currentTicket.last_activity || currentTicket.created_at);
    const activityLabel = activityAge === 'сейчас' ? activityAge : `${activityAge} назад`;
    el.innerHTML = `
      <div class="meta-summary">
        <span class="meta-state ${pending ? 'waiting' : ''}">${esc(pending ? 'Ждёт ответа' : 'На контроле')}</span>
        <span class="meta-separator"></span>
        <span class="meta-fact">${esc(activityLabel)}</span>
        <span class="meta-separator"></span>
        <span class="meta-fact">Ответ: ${esc(firstResponse ? fmtTime(firstResponse.created_at) : 'нет')}</span>
      </div>
      <button id="meta-card-open" class="meta-card-open" type="button">Карточка тикета</button>`;
    $('meta-card-open')?.addEventListener('click', openTicketCard);
    renderTicketCardDialog(firstResponse, pending);
  }

  function renderTicketCardDialog(firstResponse, pending) {
    let dialog = $('ticket-card-dialog');
    if (!dialog) {
      dialog = document.createElement('div');
      dialog.id = 'ticket-card-dialog';
      dialog.className = 'ticket-card-dialog';
      document.body.appendChild(dialog);
    }
    dialog.classList.toggle('open', cardOpen);
    dialog.setAttribute('aria-hidden', cardOpen ? 'false' : 'true');
    const telegram = telegramProfile(currentTicket);
    const customerDetails = currentTicket.source === 'telegram' && telegram.id
      ? `<div class="ticket-customer">
          <div class="ticket-customer-title"><span class="ticket-source-badge">Telegram</span><b>Профиль клиента</b></div>
          <dl class="ticket-customer-grid">
            <div><dt>Telegram ID</dt><dd>${esc(telegram.id)}</dd></div>
            <div><dt>Username</dt><dd>${telegram.username ? `@${esc(telegram.username)}` : 'не указан'}</dd></div>
            <div><dt>Имя</dt><dd>${esc(currentTicket.telegram_customer_first_name || '—')}</dd></div>
            <div><dt>Фамилия</dt><dd>${esc(currentTicket.telegram_customer_last_name || '—')}</dd></div>
            <div><dt>Язык</dt><dd>${esc(currentTicket.telegram_customer_language_code || '—')}</dd></div>
            <div><dt>Chat ID</dt><dd>${esc(currentTicket.telegram_customer_chat_id || '—')}</dd></div>
          </dl>
          <div class="ticket-customer-actions">
            <a class="customer-action primary" href="${esc(telegram.directUrl)}">Написать лично</a>
            ${telegram.profileUrl ? `<a class="customer-action" href="${esc(telegram.profileUrl)}" target="_blank" rel="noopener noreferrer">Открыть профиль</a>` : ''}
            <button id="copy-telegram-id" class="customer-action" type="button">Копировать ID</button>
          </div>
        </div>`
      : `<div class="ticket-customer compact"><span class="ticket-source-badge web">Сайт</span><span>Обращение создано в веб-чате</span></div>`;
    dialog.innerHTML = `
      <button class="ticket-card-backdrop" type="button" aria-label="Закрыть карточку"></button>
      <section class="ticket-card-sheet" role="dialog" aria-modal="true" aria-labelledby="ticket-card-title">
        <div class="ticket-card-head">
          <div><h3 id="ticket-card-title">Карточка тикета</h3><p>${esc(currentTicket.user_name || 'Клиент')} · #${esc(String(currentTicket.id || '').slice(0, 8))}</p></div>
          <button id="ticket-card-close" class="ticket-card-close" type="button" aria-label="Закрыть">×</button>
        </div>
        <div class="ticket-card-stats">
          <div><b>${esc(pending ? 'Ждёт ответа' : 'На контроле')}</b><span>Статус</span></div>
          <div><b>${esc(timeAgo(currentTicket.last_activity || currentTicket.created_at))}</b><span>Активность</span></div>
          <div><b>${esc(firstResponse ? fmtTime(firstResponse.created_at) : 'нет')}</b><span>Первый ответ</span></div>
        </div>
        ${customerDetails}
        <div class="ticket-card-fields">
          <div class="meta-field"><label for="meta-tags">Метки через запятую</label><input id="meta-tags" maxlength="180" value="${esc(tagsArray(currentTicket).join(', '))}" placeholder="vpn, оплата, срочно"></div>
          <div class="meta-field"><label for="meta-note">Внутренняя заметка</label><textarea id="meta-note" maxlength="1200" rows="4" placeholder="Видно только оператору">${esc(currentTicket.admin_note || '')}</textarea></div>
        </div>
        <div class="preset-tags">
          ${['срочно','оплата','vpn','ios','android','роутер','ждет клиента'].map(tag => `<button type="button" data-tag-preset="${esc(tag)}">${esc(tag)}</button>`).join('')}
        </div>
        <div class="ticket-card-actions">
          <button id="meta-cancel" class="meta-cancel" type="button">Отмена</button>
          <button id="meta-save" class="meta-save" type="button">Сохранить</button>
        </div>
      </section>`;
    dialog.querySelector('.ticket-card-backdrop')?.addEventListener('click', closeTicketCard);
    $('ticket-card-close')?.addEventListener('click', closeTicketCard);
    $('meta-cancel')?.addEventListener('click', closeTicketCard);
    $('meta-save')?.addEventListener('click', saveTicketMeta);
    $('copy-telegram-id')?.addEventListener('click', () => copyTelegramId(telegram.id));
    dialog.querySelectorAll('[data-tag-preset]').forEach(btn => btn.addEventListener('click', () => addPresetTag(btn.dataset.tagPreset)));
  }

  async function copyTelegramId(id) {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      const input = document.createElement('textarea');
      input.value = id;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    const button = $('copy-telegram-id');
    if (button) {
      const original = button.textContent;
      button.textContent = 'ID скопирован';
      setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1500);
    }
  }

  function openTicketCard() {
    cardOpen = true;
    if (!currentTicket) return;
    renderTicketMeta();
    setTimeout(() => $('meta-tags')?.focus(), 0);
  }

  function closeTicketCard() {
    cardOpen = false;
    $('ticket-card-dialog')?.classList.remove('open');
    $('ticket-card-dialog')?.setAttribute('aria-hidden', 'true');
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
    closeTicketCard();
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
      if (currentTicket?.id !== payload.ticket?.id) cardOpen = false;
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

  wrapSocketFactory();
  observeDom();
  window.adminOpenTicketCard = openTicketCard;
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && cardOpen) closeTicketCard();
  });
})();
