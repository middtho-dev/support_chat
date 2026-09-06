'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const S = { token: null, view: 'frp', permissions: { canManageSettings: true } };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer;
  function toast(message) { $('toast').textContent = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 5000); }
  let current = null, pending = false, loading = false;
  const panel = $('frp');
  panel.innerHTML = `<div class="frp-wrap">
    <h2>FRP · Устройства</h2>
    <p>Удалённый доступ через routers.kv9.ru. Порты туннелей: 2000–65535, кроме служебных и занятых портов.</p>
    <p id="frp-status" role="status">Загрузка…</p>
    <p id="frp-error" role="alert"></p>
    <div class="frp-actions"><button data-frp-action="install">Установить FRP</button><button data-frp-action="start">Включить</button><button data-frp-action="stop" class="danger">Выключить</button><button id="frp-refresh" class="ghost">Обновить</button></div>
    <form id="frp-settings" class="frp-actions"><label>Домен сервера<input id="frp-host" value="routers.kv9.ru" required maxlength="253"></label><label>Порт подключения<input id="frp-port" type="number" min="2000" max="65535" value="7000" required></label><button type="submit">Сохранить настройки</button></form>
    <p>Установите сервер, затем нажмите «Включить». Включённый сервер автоматически запускается вместе с приложением. Для изменения настроек сначала выключите FRP.</p>
    <h3>Подключённые устройства <span id="frp-client-count"></span></h3>
    <div class="frp-table"><table><thead><tr><th>Устройство / ID</th><th>IP</th><th>Статус</th><th>Порты TCP/UDP</th></tr></thead><tbody id="frp-clients"></tbody></table></div>
    <h3>Туннели <span id="frp-count"></span></h3>
    <input id="frp-search" type="search" placeholder="Поиск по имени или порту" aria-label="Поиск устройств">
    <p>Имя задаётся на устройстве в frpc.toml. Каждый TCP/UDP-туннель показан отдельной строкой; используйте имя устройства как префикс. Список обновляется каждые 5 секунд.</p>
    <div class="frp-table"><table><thead><tr><th>Имя</th><th>Статус</th><th>Протокол</th><th>Порт</th><th>Соединения</th><th>Последний раз в сети</th></tr></thead><tbody id="frp-devices"></tbody></table></div>
    <details id="frp-example"><summary>Подключить устройство — пример frpc.toml</summary><p>На устройстве нужен клиент frpc. Замените имя на уникальное, localPort — на порт сервиса устройства, remotePort — на свободный порт сервера. Для нескольких сервисов добавьте блоки [[proxies]].</p><button id="frp-copy" type="button">Скопировать конфигурацию</button><pre id="frp-config"></pre><p>Конфигурация содержит секрет подключения. DNS routers.kv9.ru должен указывать на этот сервер; порт подключения и используемые порты туннелей должны быть разрешены в firewall.</p></details>
  </div>`;
  function example() {
    return current ? `serverAddr = ${JSON.stringify(current.host)}\nserverPort = ${current.port}\nauth.method = "token"\nauth.token = ${JSON.stringify(current.token)}\ntransport.tls.enable = true\n\n[[proxies]]\nname = "router-01-ssh"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\nremotePort = ${current.port === 2000 ? 2001 : 2000}\n` : '';
  }
  function renderDevices() {
    const devices = current?.devices || [];
    const clients = current?.clients || [];
    $('frp-client-count').textContent = `(${clients.filter(c => c.online).length} онлайн / ${clients.length} всего)`;
    $('frp-clients').innerHTML = clients.map(c => `<tr><td>${esc(c.hostname || c.user || c.clientID || c.key)}</td><td>${esc(c.ip || '—')}</td><td>${c.stale ? 'Нет данных' : c.online ? '🟢 Онлайн' : 'Отключено'}</td><td>${esc(devices.filter(d => d.clientID === c.clientID && d.user === c.user && c.clientID).map(d => `${d.port ?? '—'}/${d.type}`).join(', ') || '—')}</td></tr>`).join('') || '<tr><td colspan="4">Устройства ещё не подключались</td></tr>';
    const search = $('frp-search').value.toLowerCase();
    $('frp-count').textContent = `(${devices.filter(d => d.online).length} онлайн / ${devices.length} всего)`;
    $('frp-devices').innerHTML = devices.filter(d => `${d.name} ${d.port}`.toLowerCase().includes(search))
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.port || 0) - (b.port || 0))
      .map(d => `<tr><td>${esc(d.name)}</td><td>${d.stale ? 'Нет данных' : d.online ? '🟢 Онлайн' : 'Отключено'}</td><td>${esc(d.type.toUpperCase())}</td><td>${esc(d.port ?? '—')}</td><td>${d.online ? esc(d.connections) : '—'}</td><td>${d.lastSeen ? esc(new Date(d.lastSeen).toLocaleString('ru-RU')) : '—'}</td></tr>`).join('') || '<tr><td colspan="6">Устройства не найдены. Подключите frpc с конфигурацией ниже.</td></tr>';
  }
  function render(updateFields = false) {
    if (!current) return;
    $('frp-status').textContent = `${current.running ? '🟢 Сервер включён' : current.installed ? 'Сервер выключен' : 'FRP не установлен'}${current.version ? ` · v${current.version}` : ''} · ${current.host}:${current.port}${current.busy ? ' · Выполняется операция…' : ''}`;
    $('frp-error').textContent = current.error || current.monitoringError || '';
    const locked = pending || current.busy;
    panel.querySelector('[data-frp-action="install"]').disabled = locked || current.running;
    panel.querySelector('[data-frp-action="install"]').textContent = current.installed ? 'Обновить FRP' : 'Установить FRP';
    panel.querySelector('[data-frp-action="start"]').disabled = locked || current.running || !current.installed;
    panel.querySelector('[data-frp-action="stop"]').disabled = locked || (!current.running && !current.enabled);
    $('frp-settings').querySelectorAll('input,button').forEach(el => { el.disabled = locked || current.running; });
    if (updateFields) { $('frp-host').value = current.host; $('frp-port').value = current.port; }
    $('frp-config').textContent = $('frp-example').open ? example() : '';
    renderDevices();
  }
  async function request(action, body) {
    const response = await fetch(`/api/admin/frp${action ? `/${action}` : ''}`, {
      method: action ? 'POST' : 'GET', headers: { 'x-admin-token': S.token, 'Content-Type': 'application/json' },
      ...(action ? { body: JSON.stringify(body || {}) } : {})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  async function load() {
    if (loading || pending || !S.token || S.view !== 'frp') return;
    if (!S.permissions.canManageSettings) { panel.querySelector('.frp-wrap').hidden = true; return; }
    panel.querySelector('.frp-wrap').hidden = false;
    loading = true;
    const token = S.token;
    try { const data = await request(); if (token !== S.token) return; const first = !current; current = data; render(first); }
    catch (e) { $('frp-error').textContent = `Не удалось обновить состояние: ${e.message}`; if (current) { [...current.devices, ...(current.clients || [])].forEach(d => { d.stale = true; d.online = false; }); renderDevices(); } }
    finally { loading = false; }
  }
  async function action(name, body) {
    if (pending) return;
    pending = true; render();
    $('frp-error').textContent = '';
    $('frp-status').textContent = name === 'install' ? 'Загрузка и проверка официального FRP…' : 'Выполняется операция…';
    const token = S.token;
    try { const data = await request(name, body); if (token !== S.token) return; current = data; toast('Готово', 'ok'); }
    catch (e) { toast(e.message, 'err'); if (current) current.error = e.message; }
    finally { pending = false; render(true); }
  }
  panel.querySelectorAll('[data-frp-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.frpAction)));
  $('frp-settings').addEventListener('submit', event => { event.preventDefault(); action('configure', { host: $('frp-host').value, port: Number($('frp-port').value) }); });
  $('frp-refresh').addEventListener('click', load);
  $('frp-search').addEventListener('input', renderDevices);
  $('frp-example').addEventListener('toggle', () => { $('frp-config').textContent = $('frp-example').open ? example() : ''; });
  $('frp-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(example()); toast('Конфигурация скопирована', 'ok'); } catch { toast('Выделите и скопируйте конфигурацию вручную', 'err'); } });
  $('login').addEventListener('submit', async event => {
    event.preventDefault();
    S.token = $('login-token').value;
    try {
      current = await request();
      $('login-token').value = ''; $('login-error').textContent = '';
      $('login').hidden = true; panel.hidden = false; $('logout').hidden = false; render(true);
    } catch (e) { S.token = null; $('login-error').textContent = e.message; }
  });
  $('logout').addEventListener('click', () => {
    S.token = null; current = null; $('frp-config').textContent = ''; $('frp-devices').textContent = '';
    panel.hidden = true; $('login').hidden = false; $('logout').hidden = true;
  });
  setInterval(() => { if (!document.hidden) load(); }, 5000);
})();
