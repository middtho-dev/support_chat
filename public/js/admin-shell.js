'use strict';
// Each new tool registers one section here and provides its own panel and API.
window.AdminShell = (() => {
  const modules = [
    { id: 'home', label: 'Обзор', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
    { id: 'chat', label: 'Поддержка', description: 'Диалоги с клиентами, сообщения и история обращений.', icon: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z' },
    { id: 'frp', label: 'Устройства', description: 'Удалённый доступ, веб-интерфейсы и управление FRP.', manager: true, icon: 'M3 4h18v12H3zM8 21h8M12 16v5M6 8h2M6 12h4' },
    { id: 'templates', label: 'Шаблоны', description: 'Готовые ответы для поддержки. Сохраняются в этом браузере.', icon: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5' },
    { id: 'settings', label: 'Управление', description: 'Состояние системы, операторы и настройки поддержки.', icon: 'M4 7h16M4 17h16M8 4v6M16 14v6' }
  ];
  const icon = m => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${m.icon}"/></svg>`;
  document.querySelector('.rail').innerHTML = modules.map(m => `<button type="button" class="navbtn" data-view="${m.id}" aria-label="${m.label}" title="${m.label}" ${m.manager ? 'hidden' : ''}>${icon(m)}<span>${m.label}</span></button>`).join('');
  function render(state) {
    const allowed = modules.filter(m => !m.manager || state.permissions.canManageSettings);
    document.querySelectorAll('.navbtn').forEach(b => { b.hidden = !allowed.some(m => m.id === b.dataset.view); });
    const open = state.tickets.filter(t => t.status === 'open').length;
    const unread = state.tickets.filter(t => t.unread_count > 0).length;
    document.getElementById('home').innerHTML = `<div class="section shell-home"><div class="page-heading"><span class="eyebrow">Рабочее пространство</span><h2>Всё необходимое — в одной панели</h2><p>Выберите инструмент и продолжайте работу.</p></div><div class="overview-stats"><div><span>Открытые обращения</span><strong>${open}</strong></div><div><span>Требуют прочтения</span><strong>${unread}</strong></div><div><span>Доступные разделы</span><strong>${allowed.length - 1}</strong></div></div><h3 class="module-heading">Инструменты</h3><div class="module-grid">${allowed.filter(m => m.id !== 'home').map(m => `<button class="module-card" type="button" data-module-target="${m.id}"><span class="module-icon">${icon(m)}</span><span class="module-copy"><strong>${m.label}</strong><span>${m.description}</span></span><span aria-hidden="true" class="module-arrow">↗</span></button>`).join('')}</div><p class="workspace-note">Единый вход · Поддержка компьютеров и мобильных устройств</p></div>`;
  }
  document.getElementById('home').addEventListener('click', e => { const target = e.target.closest('[data-module-target]'); if (target) setView(target.dataset.moduleTarget); });
  return { modules, render };
})();
