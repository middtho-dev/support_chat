'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const integration = window.FRP_INTEGRATION;
  const S = integration?.state || { token: null, view: 'frp', permissions: { canManageSettings: true } };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let toastTimer;
  function toast(message) { if (integration) return integration.toast(message); $('toast').textContent = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').textContent = ''; }, 5000); }
  let current = null, pending = false, loading = false, generation = 0;
  const panel = $('frp');
  panel.innerHTML = `<div class="frp-wrap">
    <h2>FRP</h2>
    <p id="frp-summary"></p>
    <p id="frp-status" role="status">Загрузка…</p>
    <p id="frp-error" role="alert"></p>
    <div class="frp-actions"><button data-frp-action="install">Установить FRP</button><button id="frp-toggle" data-frp-action="start">Включить</button><button id="frp-refresh" class="ghost">Обновить</button></div>
    <details class="frp-settings-details"><summary>Настройки сервера</summary><form id="frp-settings" class="frp-actions"><details class="frp-config-group"><summary>Подключение и защита</summary><div class="frp-config-grid"><label>Подключение устройств<select id="frp-compatibilityMode"><option value="false">Токен и обязательный TLS</option><option value="true">Существующие конфиги: без токена, TLS необязателен</option></select><small>Для новых клиентов используйте токен и TLS. В режиме совместимости любой клиент, знающий адрес, может зарегистрировать туннель.</small></label><label>Домен сервера<input id="frp-host" required maxlength="253"><small>Домен или IP, по которому устройства подключаются к серверу.</small></label><label>Порт подключения<input id="frp-port" type="number" min="1000" max="65535" required><small>Входной порт FRP. Должен быть доступен устройствам через firewall.</small></label><label>Адрес прослушивания<input id="frp-bindAddr" required><small>Локальный адрес интерфейса, на котором сервер принимает подключения.</small></label><label>Новый токен устройств<input id="frp-newToken" type="password" autocomplete="new-password" placeholder="Пусто — оставить текущий" minlength="24" maxlength="256"><small>Не менее 24 символов. Пусто — оставить текущий. Новый токен потребуется указать на устройствах.</small></label></div></details><details class="frp-config-group"><summary>Порты туннелей</summary><div class="frp-config-grid"><label>Порты туннелей: от<input id="frp-portStart" type="number" min="1000" max="65535" required><small>Нижняя граница диапазона портов, выделяемых туннелям.</small></label><label>До<input id="frp-portEnd" type="number" min="1000" max="65535" required><small>Верхняя граница диапазона. Служебные порты исключаются автоматически.</small></label><label>Дополнительные исключения (через запятую)<input id="frp-reservedPorts"><small>Занятые другими сервисами порты, которые нельзя отдавать устройствам.</small></label></div></details><details class="frp-config-group"><summary>Мониторинг и история</summary><div class="frp-config-grid"><label>Обновлять каждые, сек.<input id="frp-refreshSeconds" type="number" min="2" max="300" required><small>Частота автоматической проверки статусов на этой странице.</small></label><label>Лимит истории<input id="frp-historyLimit" type="number" min="100" max="100000" required><small>Максимальное число сохраняемых записей истории.</small></label></div></details><p>После изменения адреса, порта или токена обновите конфигурацию на устройствах.</p><button type="submit">Сохранить и применить</button></form>
    <p>Установите сервер, затем нажмите «Включить». Включённый сервер автоматически запускается вместе с приложением. Сохранение настроек работающего сервера кратко перезапускает FRP; устройства переподключаются.</p>
    <p id="frp-exclusions"></p></details><h3>Устройства <span id="frp-count"></span></h3>
    <input id="frp-search" type="search" placeholder="Поиск по имени, IP или порту" aria-label="Поиск устройств">
    <p>Нажмите имя для входа в веб-интерфейс. Онлайн — устройство подключено к FRP.</p>
    <div class="frp-table"><table><thead><tr><th>Устройство</th><th>IP</th><th>Статус</th><th>Порты</th><th>Соединения</th><th>Последний раз в сети</th></tr></thead><tbody id="frp-devices"></tbody></table></div>
    <section class="frp-installer" aria-labelledby="frp-installer-title"><h3 id="frp-installer-title">Подключить роутер OpenWrt</h3><p>Скачайте установочный файл и запустите его на Windows 10/11 в сети роутера. Он установит FRPC и интерфейс LuCI через opkg или apk, затем настроит доступ к веб-интерфейсу на 127.0.0.1:80.</p>
    <form id="frp-installer-form"><div class="frp-installer-grid"><label>Внешний порт<div class="frp-port-picker"><input id="frp-installer-port" type="number" min="20000" max="23000" required><button id="frp-random-port" class="ghost" type="button" aria-label="Выбрать другой свободный порт">Другой</button></div><small>20000–23000. Занятые и выданные порты исключаются.</small></label><label>IP роутера<input id="frp-router-ip" value="192.168.1.1" required maxlength="45" autocomplete="off" spellcheck="false"><small>Адрес роутера в сети компьютера.</small></label><label>Пароль SSH · root<input id="frp-router-password" type="password" required maxlength="512" autocomplete="new-password"><small>Пароль включается в файл, но не сохраняется в настройках.</small></label></div><details><summary>Дополнительно</summary><label>Порт SSH<input id="frp-router-ssh-port" type="number" min="1" max="65535" value="22" required></label></details><p id="frp-installer-route"></p><button id="frp-generate" type="submit">Сгенерировать .bat</button><p id="frp-installer-result" role="status"></p><p>На компьютере нужен интернет. При первом SSH-подключении проверьте отпечаток ключа роутера. Настройки останутся доступны в LuCI; существующий конфиг будет сохранён в резервную копию. Файл содержит пароль — передавайте его только владельцу роутера и удалите после установки.</p></form>
    <details><summary>Выданные установочные файлы <span id="frp-reservation-count"></span></summary><p>Порт резервируется при генерации. Освобождайте только порт неиспользованного файла: после освобождения старый файл нельзя запускать. Порты известных устройств остаются занятыми.</p><div id="frp-reservations"></div></details></section>
  </div>`;
  let downloadUrl = null;
  function clearDownload() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
    $('frp-installer-result').textContent = '';
    $('frp-router-password').value = '';
  }
  function renderInstaller() {
    if (!$('frp-installer-port').value && current.installerPort) $('frp-installer-port').value = current.installerPort;
    $('frp-installer-route').textContent = `${current.host}:${$('frp-installer-port').value || '—'} → 127.0.0.1:80 · FRP ${current.host}:${current.port}`;
    $('frp-installer-form').querySelectorAll('input,button').forEach(el => { el.disabled = pending || current.busy; });
    $('frp-generate').disabled = pending || current.busy || !current.installerPort;
    $('frp-random-port').disabled = pending || current.busy || !current.installerPort;
    const reservations = current.installerReservations || [];
    $('frp-reservation-count').textContent = `(${reservations.length})`;
    $('frp-reservations').innerHTML = reservations.map(r => `<div class="frp-reservation"><span><strong>${esc(r.port)}</strong> · ${esc(r.ip)}<small>${esc(new Date(r.createdAt).toLocaleString('ru-RU'))}</small></span><button class="ghost" type="button" data-release-port="${esc(r.port)}" ${pending ? 'disabled' : ''}>Освободить</button></div>`).join('') || '<p>Пока нет выданных файлов.</p>';
    if (!current.installerPort) $('frp-installer-route').textContent = 'Нет свободных разрешённых портов 20000–23000. Проверьте диапазон сервера и выданные файлы.';
  }
  function link(proxy, label) {
    const url = window.FrpLinks.deviceUrl(current?.host, proxy);
    return url ? `<a data-device-link href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
  }
  function renderDevices() {
    const devices = window.FrpLinks.groupDevices(current?.devices, current?.clients);
    const search = $('frp-search').value.toLowerCase();
    $('frp-count').textContent = `(${devices.filter(d => d.online).length} онлайн / ${devices.length} всего)`;
    const rows = devices.filter(d => `${d.name} ${d.ip} ${d.ports.map(p => `${p.name} ${p.port}`).join(' ')}`.toLowerCase().includes(search))
      .map(d => `<tr><td>${link(d.primary, d.name)}${!d.primary ? '<br><small>Нет активного веб-туннеля</small>' : ''}</td><td data-label="IP-адрес">${esc(d.ip || '—')}</td><td data-label="Состояние">${d.stale ? 'Нет данных' : d.online ? '🟢 Онлайн' : 'Отключено'}</td><td data-label="Порты">${d.ports.map(p => `<span title="${esc(p.name)}">${esc(p.port ?? '—')}/${esc(p.type)}${/luci|web|http/i.test(p.name) ? ' · Веб' : /ssh/i.test(p.name) ? ' · SSH' : ''}${!p.online ? ' · отключён' : ''}</span>`).join('<br>') || 'Без туннелей'}</td><td data-label="Соединения">${d.online ? esc(d.connections) : '—'}</td><td data-label="Последняя активность">${d.lastSeen ? esc(new Date(d.lastSeen).toLocaleString('ru-RU')) : '—'}</td></tr>`).join('') || '<tr><td colspan="6">Устройства не найдены</td></tr>';
    const table=$('frp-devices');if(table.innerHTML!==rows&&!table.contains(document.activeElement))table.innerHTML=rows;
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
    const running=current.running||current.enabled;
    $('frp-toggle').dataset.frpAction=running?'stop':'start';$('frp-toggle').textContent=running?'Выключить':'Включить';$('frp-toggle').className=running?'danger':'';$('frp-toggle').disabled=locked||!current.installed;
    $('frp-settings').querySelectorAll('input,button,select').forEach(el => { el.disabled = locked; });
    if (updateFields) { for (const key of ['compatibilityMode', 'host', 'port', 'bindAddr', 'portStart', 'portEnd', 'reservedPorts', 'refreshSeconds', 'historyLimit']) $('frp-' + key).value = Array.isArray(current[key]) ? current[key].join(',') : current[key]; $('frp-newToken').value = ''; }
    renderInstaller();
    renderDevices();
  }
  async function request(action, body) {
    const response = await fetch(`/api/admin/frp${action ? `/${action}` : ''}`, {
      method: action ? 'POST' : 'GET', headers: { 'x-admin-token': S.token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(action ? 120000 : 10000), cache: 'no-store',
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
    const token = S.token, g = generation;
    try { const data = await request(); if (token !== S.token || g !== generation) return; const first = !current; current = data; render(first); }
    catch (e) { if (token !== S.token || g !== generation) return; $('frp-error').textContent = `Не удалось обновить состояние: ${e.message}`; if (current) { [...current.devices, ...(current.clients || [])].forEach(d => { d.stale = true; d.online = false; }); renderDevices(); } }
    finally { if(g === generation) loading = false; }
  }
  async function action(name, body) {
    if (pending) return;
    generation++; loading = false;
    pending = true; render();
    $('frp-error').textContent = '';
    $('frp-status').textContent = name === 'install' ? 'Загружаем и проверяем FRP…' : 'Выполняется операция…';
    const token = S.token, g = generation; let applied = false;
    try { const data = await request(name, body); if (token !== S.token || g !== generation) return; current = data; applied = true; toast('Готово', 'ok'); }
    catch (e) { if (token !== S.token || g !== generation) return; toast(e.message, 'err'); if (current) current.error = e.message; }
    finally { if(g === generation && token === S.token){pending = false; render(applied && name === 'configure');} }
  }
  panel.querySelectorAll('[data-frp-action]').forEach(button => button.addEventListener('click', () => action(button.dataset.frpAction)));
  $('frp-settings').addEventListener('submit', event => { event.preventDefault(); action('configure', Object.fromEntries(['compatibilityMode', 'host', 'port', 'bindAddr', 'portStart', 'portEnd', 'reservedPorts', 'refreshSeconds', 'historyLimit', 'newToken'].map(key => [key, $('frp-' + key).value]))); });
  $('frp-refresh').addEventListener('click', load);
  $('frp-search').addEventListener('input', renderDevices);
  $('frp-installer-port').addEventListener('input', () => { if (current) renderInstaller(); });
  $('frp-random-port').addEventListener('click', async () => {
    if (pending) return;
    const token = S.token, g = generation;
    $('frp-random-port').disabled = true;
    try { const data = await request(); if (token !== S.token || g !== generation) return; current = data; $('frp-installer-port').value = current.installerPort || ''; render(); }
    catch (e) { if (token === S.token && g === generation) { toast(e.message, 'err'); render(); } }
  });
  $('frp-reservations').addEventListener('click', event => {
    const button = event.target.closest('[data-release-port]');
    if (button && confirm('Освободить порт? Старый установочный файл после этого нельзя использовать.')) action('release-installer', { port: Number(button.dataset.releasePort) });
  });
  $('frp-installer-form').addEventListener('submit', async event => {
    event.preventDefault(); if (pending || !current) return;
    const body = { port: Number($('frp-installer-port').value), ip: $('frp-router-ip').value.trim(), password: $('frp-router-password').value, sshPort: Number($('frp-router-ssh-port').value) };
    clearDownload(); generation++; loading = false; pending = true; render();
    const token = S.token, g = generation;
    $('frp-installer-result').textContent = 'Проверяем порт и создаём файл…';
    try {
      const data = await request('generate-installer', body);
      if (token !== S.token || g !== generation) return;
      current = data.status;
      downloadUrl = URL.createObjectURL(new Blob([data.file], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a'); anchor.href = downloadUrl; anchor.download = data.filename; anchor.textContent = `Скачать ${data.filename}`;
      $('frp-installer-result').replaceChildren(anchor); anchor.click();
      $('frp-installer-port').value = current.installerPort || '';
      toast('Файл готов. Порт зарезервирован.', 'ok');
    } catch (e) { if (token === S.token && g === generation) $('frp-installer-result').textContent = e.message; }
    finally { body.password = ''; if (token === S.token && g === generation) { pending = false; render(); } }
  });
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
    generation++; pending = false; loading = false; S.token = null; current = null; clearDownload(); $('frp-installer-port').value = ''; $('frp-reservations').textContent = '';  $('frp-devices').textContent = '';
    panel.hidden = true; $('login').hidden = false; $('logout').hidden = true;
  });
  }
  window.FrpPanel = {
    open: load,
    reset: () => { generation++; loading = false; pending = false; current = null; clearDownload(); $('frp-installer-port').value = ''; $('frp-reservations').textContent = '';  $('frp-devices').textContent = ''; $('frp-status').textContent = 'Загрузка…'; }
  };
  panel.addEventListener('click', event => {
    const anchor = event.target.closest('[data-device-link]');
    if (!anchor) return;
    if (integration) { event.preventDefault(); integration.openLink(anchor.href); }
  });
  async function poll() { if (!document.hidden) await load(); setTimeout(poll, (current?.refreshSeconds || 5) * 1000); }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
  window.addEventListener('online',load);
  poll();
})();
