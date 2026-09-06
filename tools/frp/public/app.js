'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const integration = window.FRP_INTEGRATION;
  const S = integration?.state || { token: null, view: 'frp', permissions: { canManageSettings: true } };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer;
  function toast(message) { if (integration) return integration.toast(message); $('toast').textContent = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 5000); }
  let current = null, pending = false, loading = false;
  const panel = $('frp');
  panel.innerHTML = `<div class="frp-wrap">
    <h2>FRP · Устройства</h2>
    <p id="frp-summary"></p>
    <p id="frp-status" role="status">Загрузка…</p>
    <p id="frp-error" role="alert"></p>
    <div class="frp-actions"><button data-frp-action="install">Установить FRP</button><button data-frp-action="start">Включить</button><button data-frp-action="stop" class="danger">Выключить</button><button id="frp-refresh" class="ghost">Обновить</button></div>
    <details class="frp-settings-details"><summary>Настройки сервера</summary><form id="frp-settings" class="frp-actions"><label>Подключение устройств<select id="frp-compatibilityMode"><option value="false">Токен и обязательный TLS</option><option value="true">Существующие конфиги: без токена, TLS необязателен</option></select></label><p>Без токена любой клиент, знающий адрес, может зарегистрировать туннель. Ключ входа в панель не меняется.</p><label>Домен сервера<input id="frp-host" required maxlength="253"></label><label>Порт подключения<input id="frp-port" type="number" min="1000" max="65535" required></label><label>Адрес прослушивания<input id="frp-bindAddr" required></label><label>Порты туннелей: от<input id="frp-portStart" type="number" min="1000" max="65535" required></label><label>До<input id="frp-portEnd" type="number" min="1000" max="65535" required></label><label>Дополнительные исключения (через запятую)<input id="frp-reservedPorts"></label><label>Обновлять каждые, сек.<input id="frp-refreshSeconds" type="number" min="2" max="300" required></label><label>Лимит истории<input id="frp-historyLimit" type="number" min="100" max="100000" required></label><label>Новый токен устройств<input id="frp-newToken" type="password" autocomplete="new-password" placeholder="Пусто — оставить текущий" minlength="24" maxlength="256"></label><p>После изменения адреса, порта или токена обновите конфигурацию на устройствах.</p><button type="submit">Сохранить и применить</button></form>
    <p>Установите сервер, затем нажмите «Включить». Включённый сервер автоматически запускается вместе с приложением. Сохранение настроек работающего сервера кратко перезапускает FRP; устройства переподключаются.</p>
    <p id="frp-exclusions"></p></details><h3>Устройства <span id="frp-count"></span></h3>
    <input id="frp-search" type="search" placeholder="Поиск по имени, IP или порту" aria-label="Поиск устройств">
    <p>Одна строка — одно устройство. Нажмите имя, чтобы открыть веб-интерфейс. Все порты устройства показаны в этой же строке. «Онлайн» означает подключение к FRP, а не проверку веб-сервиса.</p>
    <div class="frp-table"><table><thead><tr><th>Устройство</th><th>IP</th><th>Статус</th><th>Порты</th><th>Соединения</th><th>Последний раз в сети</th></tr></thead><tbody id="frp-devices"></tbody></table></div>
    <details id="frp-example"><summary>Подключить устройство — пример frpc.toml</summary><p>На устройстве нужен клиент frpc. Замените имя на уникальное, localPort — на порт сервиса устройства, remotePort — на свободный порт сервера. Для нескольких сервисов добавьте блоки [[proxies]].</p><button id="frp-copy" type="button">Скопировать конфигурацию</button><pre id="frp-config"></pre><p>Конфигурация содержит секрет подключения. Указанный в настройках домен должен указывать на этот сервер; порт подключения и используемые порты туннелей должны быть разрешены в firewall.</p></details>
  </div>`;
  function example() {
    return current ? `serverAddr = ${JSON.stringify(current.host)}\nserverPort = ${current.port}${current.compatibilityMode ? "" : `\nauth.method = "token"\nauth.token = ${JSON.stringify(current.token)}\ntransport.tls.enable = true`}\n\n[[proxies]]\nname = "router-01-ssh"\ntype = "tcp"\nlocalIP = "127.0.0.1"\nlocalPort = 22\nremotePort = ${current.allowedRanges[0]?.start ?? "PORT_REQUIRED"}\n` : '';
  }
  function link(proxy, label) {
    const url = window.FrpLinks.deviceUrl(current?.host, proxy);
    return url ? `<a data-device-link href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
  }
  function renderDevices() {
    const devices = window.FrpLinks.groupDevices(current?.devices, current?.clients);
    const search = $('frp-search').value.toLowerCase();
    $('frp-count').textContent = `(${devices.filter(d => d.online).length} онлайн / ${devices.length} всего)`;
    $('frp-devices').innerHTML = devices.filter(d => `${d.name} ${d.ip} ${d.ports.map(p => `${p.name} ${p.port}`).join(' ')}`.toLowerCase().includes(search))
      .map(d => `<tr><td>${link(d.primary, d.name)}${!d.primary ? '<br><small>Нет активного веб-туннеля</small>' : ''}</td><td>${esc(d.ip || '—')}</td><td>${d.stale ? 'Нет данных' : d.online ? '🟢 Онлайн' : 'Отключено'}</td><td>${d.ports.map(p => `<span title="${esc(p.name)}">${esc(p.port ?? '—')}/${esc(p.type)}${/luci|web|http/i.test(p.name) ? ' · Веб' : /ssh/i.test(p.name) ? ' · SSH' : ''}${!p.online ? ' · отключён' : ''}</span>`).join('<br>') || 'Без туннелей'}</td><td>${d.online ? esc(d.connections) : '—'}</td><td>${d.lastSeen ? esc(new Date(d.lastSeen).toLocaleString('ru-RU')) : '—'}</td></tr>`).join('') || '<tr><td colspan="6">Устройства не найдены</td></tr>';
  }
  function render(updateFields = false) {
    if (!current) return;
    $('frp-summary').textContent = `Удалённый доступ через ${current.host}:${current.port}. Порты туннелей: ${current.portStart}–${current.portEnd}, кроме служебных и исключённых. Обновление: ${current.refreshSeconds} сек.`;
    $('frp-status').textContent = `${current.running ? '🟢 Сервер включён' : current.installed ? 'Сервер выключен' : 'FRP не установлен'}${current.version ? ` · v${current.version}` : ''} · ${current.host}:${current.port}${current.busy ? ' · Выполняется операция…' : ''}`;
    $('frp-exclusions').textContent = 'Исключены служебные и дополнительные порты: ' + (current.excludedPorts || current.reservedPorts).join(', ');
    $('frp-error').textContent = current.error || current.monitoringError || '';
    const locked = pending || current.busy;
    panel.querySelector('[data-frp-action="install"]').disabled = locked || current.running;
    panel.querySelector('[data-frp-action="install"]').textContent = current.installed ? 'Обновить FRP' : 'Установить FRP';
    panel.querySelector('[data-frp-action="start"]').disabled = locked || current.running || !current.installed;
    panel.querySelector('[data-frp-action="stop"]').disabled = locked || (!current.running && !current.enabled);
    $('frp-settings').querySelectorAll('input,button,select').forEach(el => { el.disabled = locked; });
    if (updateFields) { for (const key of ['compatibilityMode', 'host', 'port', 'bindAddr', 'portStart', 'portEnd', 'reservedPorts', 'refreshSeconds', 'historyLimit']) $('frp-' + key).value = Array.isArray(current[key]) ? current[key].join(',') : current[key]; $('frp-newToken').value = ''; }
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
  $('frp-settings').addEventListener('submit', event => { event.preventDefault(); action('configure', Object.fromEntries(['compatibilityMode', 'host', 'port', 'bindAddr', 'portStart', 'portEnd', 'reservedPorts', 'refreshSeconds', 'historyLimit', 'newToken'].map(key => [key, $('frp-' + key).value]))); });
  $('frp-refresh').addEventListener('click', load);
  $('frp-search').addEventListener('input', renderDevices);
  $('frp-example').addEventListener('toggle', () => { $('frp-config').textContent = $('frp-example').open ? example() : ''; });
  $('frp-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(example()); toast('Конфигурация скопирована', 'ok'); } catch { toast('Выделите и скопируйте конфигурацию вручную', 'err'); } });
  if (!integration) {
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
  }
  window.FrpPanel = {
    open: load,
    reset: () => { current = null; $('frp-config').textContent = ''; $('frp-devices').textContent = ''; $('frp-status').textContent = 'Загрузка…'; }
  };
  panel.addEventListener('click', event => {
    const anchor = event.target.closest('[data-device-link]');
    if (!anchor) return;
    if (integration) { event.preventDefault(); integration.openLink(anchor.href); }
  });
  async function poll() { if (!document.hidden) await load(); setTimeout(poll, (current?.refreshSeconds || 5) * 1000); }
  poll();
})();
