'use strict';
window.mountLampacAdvanced = function ({container, request, operation, toggle, publicUrl}) {
  let alive = true, tab = 'overview', refreshing = false, settingsLoaded = false;
  const section = container.querySelector('.voice-section');
  const heading = section.querySelector('.page-heading');
  const overview = document.createElement('div');
  [...section.children].filter(node => node !== heading).forEach(node => overview.append(node));
  const navigation = document.createElement('nav');
  navigation.className = 'lc-tabs';
  navigation.setAttribute('aria-label', 'Разделы Lampac');
  const content = document.createElement('div');
  content.className = 'lc-content';
  section.append(navigation, overview, content);
  const tabs = [['overview', 'Сервер'], ['torrents', 'Торренты'], ['clients', 'Подключения'], ['settings', 'Источники и плагины'], ['client', 'Оформление Lampa']];
  const panes = {};
  for (const [key, label] of tabs) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'ghost'; button.textContent = label;
    button.setAttribute('aria-pressed', String(key === tab));
    navigation.append(button);
    panes[key] = key === 'overview' ? overview : document.createElement('div');
    if (key !== 'overview') content.append(panes[key]);
    panes[key].hidden = key !== tab;
    button.onclick = () => {
      tab = key;
      [...navigation.children].forEach((item, index) => item.setAttribute('aria-pressed', String(tabs[index][0] === key)));
      Object.entries(panes).forEach(([name, node]) => node.hidden = name !== key);
      refresh(true);
    };
  }
  const bytes = n => {
    if (!Number.isFinite(Number(n))) return '—';
    n = Number(n); const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ']; let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toLocaleString('ru-RU', {maximumFractionDigits: 1}) + ' ' + units[i];
  };
  const date = value => new Date(value * 1000).toLocaleString('ru-RU');
  const status = ['Добавлен', 'Получение информации', 'Предзагрузка', 'Работает', 'Закрыт', 'Сохранён в базе'];
  const empty = text => `<p class="lc-empty">${esc(text)}</p>`;
  const message = document.createElement('p'); message.setAttribute('role', 'status'); section.append(message);
  function renderTorrents(data) {
    const list = data.torrents || [];
    panes.torrents.innerHTML = `<div class="card"><h3>Торренты · ${list.length}</h3><p>Состояние, буфер и скорости · обновление каждые 5 секунд.</p><details><summary>Как работают команды</summary><p>«Сбросить поток» выгружает торрент из памяти; сохранённая запись остаётся. «Удалить» удаляет запись и кеш. Обе команды могут прервать просмотр.</p><p>Размер буфера — не процент скачивания файла: TorrServer загружает нужные части видео.</p></details></div><div class="lc-list">${list.map((t, index) => `<article class="card lc-torrent"><h3>${esc(t.title || t.name || t.hash)}</h3><p>${esc(status[t.stat] || 'Состояние неизвестно')}</p><div class="lc-metrics"><span>Размер <strong>${bytes(t.torrent_size)}</strong></span><span>В буфере <strong>${bytes(t.loaded_size)}</strong></span><span>Загрузка <strong>${bytes(t.download_speed || 0)}/с</strong></span><span>Отдача <strong>${bytes(t.upload_speed || 0)}/с</strong></span><span>Пиры <strong>${esc(t.active_peers || 0)}</strong></span><span>Сиды <strong>${esc(t.connected_seeders || 0)}</strong></span></div><code>${esc(t.hash)}</code>${t.files?.length ? `<details><summary>Файлы · ${t.files.length}</summary>${t.files.map(f => `<p>${esc(f.path)} · ${bytes(f.length)}</p>`).join('')}</details>` : ''}<div class="voice-actions"><button class="ghost" data-drop="${index}">Сбросить поток</button><button class="danger" data-remove="${index}">Удалить торрент</button></div></article>`).join('') || empty('Торрентов пока нет. Они появятся после запуска видео через TorrServer.')}</div>`;
    for (const [attr, action] of [['drop', 'drop'], ['remove', 'rem']]) {
      panes.torrents.querySelectorAll(`[data-${attr}]`).forEach(button => button.onclick = async () => {
        const t = list[Number(button.dataset[attr])];
        if (!confirm(`${action === 'rem' ? 'Удалить торрент и его кеш' : 'Сбросить поток'} «${t.title || t.hash}»? Текущий просмотр будет прерван.`)) return;
        await operation('/torrents', {action, hash: t.hash}, action === 'rem' ? 'Торрент удалён' : 'Поток сброшен');
        refresh(true);
      });
    }
  }
  function renderClients(data) {
    const list = data.clients || [], blocked = data.blocked || [];
    panes.clients.innerHTML = `<div class="card"><h3>Обращения к Lampac</h3><p>Последние ${data.limit || 500} записей · история ${data.retentionDays || 7} дней.</p><details><summary>Учёт подключений и блокировка</summary><p>IP + браузер — наблюдаемое подключение, а не постоянный ID устройства. Несколько устройств за одним роутером могут иметь общий IP. «Недавно» означает запрос за последние 2 минуты, а не подтверждённый просмотр.</p><p>Блокировка закрывает новые запросы к ${esc(publicUrl)} для всего IP. Уже открытый поток может продолжить работу; при необходимости сбросьте его во вкладке «Торренты». Прямые подключения в обход Caddy здесь не учитываются.</p></details><form class="voice-actions" id="lc-block-form"><label class="voice-field">IP для блокировки<input id="lc-block-ip" required maxlength="45" placeholder="IPv4 или IPv6" autocomplete="off"></label><button class="danger" type="submit">Заблокировать IP</button></form><div id="lc-blocked">${blocked.map((ip, i) => `<p><code>${esc(ip)}</code> <button class="ghost" data-unblock="${i}">Разблокировать</button></p>`).join('')}</div></div><div class="lc-list">${list.map((c, i) => `<article class="card"><h3>${esc(c.ip)} · ${blocked.includes(c.ip) ? 'Заблокирован' : Date.now() / 1000 - c.last < 120 ? 'Недавно' : 'Неактивен'}</h3><p>${esc(c.ua || 'Браузер не передал сведения')}</p><p>Последний запрос: ${esc(date(c.last))} · ${esc(c.route)}<br>Первый запрос: ${esc(date(c.first))} · обращений: ${esc(c.requests)}</p>${c.torrent ? `<p>Последний хеш торрента: <code>${esc(c.torrent)}</code></p>` : ''}<button class="${blocked.includes(c.ip) ? 'ghost' : 'danger'}" data-client-block="${i}">${blocked.includes(c.ip) ? 'Разблокировать' : 'Заблокировать IP'}</button></article>`).join('') || empty('Пока нет обращений. Откройте Lampa или запустите видео через публичный адрес.')}</div>`;
    const block = async (ip, value) => {
      if (value && !confirm(`Заблокировать ${ip}? Доступ потеряют все устройства с этим внешним IP.`)) return;
      await operation('/clients', {ip, blocked: value}, value ? 'IP заблокирован' : 'IP разблокирован'); refresh(true);
    };
    panes.clients.querySelector('#lc-block-form').onsubmit = e => { e.preventDefault(); block(panes.clients.querySelector('#lc-block-ip').value.trim(), true); };
    panes.clients.querySelectorAll('[data-unblock]').forEach(b => b.onclick = () => block(blocked[Number(b.dataset.unblock)], false));
    panes.clients.querySelectorAll('[data-client-block]').forEach(b => b.onclick = () => { const ip = list[Number(b.dataset.clientBlock)].ip; block(ip, !blocked.includes(ip)); });
  }
  function renderSettings(data) {
    const groups = new Map();
    data.fields.forEach((f, index) => { f.index = index; if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); });
    const input = f => f.kind === 'bool' ? toggle('adv-' + f.index, f.label, f.value) : `<label class="voice-field">${esc(f.label)}${f.kind === 'secret' && f.configured ? ' · задан' : ''}<input id="lc-adv-${f.index}" type="${f.kind === 'int' ? 'number' : f.kind === 'secret' ? 'password' : f.kind === 'url' ? 'url' : 'text'}" ${f.kind === 'int' ? `min="${f.min}" max="${f.max}" step="1" required` : 'maxlength="2048"'} value="${esc(f.value ?? '')}" autocomplete="off"></label>`;
    panes.settings.innerHTML = `<form id="lc-advanced-form"><div class="card"><h3>Источники, плагины и сервер</h3><p>Показаны параметры, которые есть в текущей версии Lampac. Сохраняются только ваши изменения; скрытые настройки и токены сохраняются. Прокси источника использует ранее настроенный прокси Lampac. Изменение адреса источника может потребовать другой токен.</p><label class="voice-field">Поиск источника или раздела<input id="lc-provider-search" type="search" placeholder="Например, Filmix или плагины"></label><p id="lc-dirty" role="status">Нет изменений</p><button class="save" type="submit">Сохранить изменения</button></div>${[...groups].map(([group, fields]) => `<details class="card lc-config-group" data-group="${esc(group.toLowerCase())}" ${group.startsWith('Источник') ? '' : 'open'}><summary>${esc(group)}</summary><div class="voice-grid">${fields.map(input).join('')}</div></details>`).join('')}</form>`;
    const changes = () => Object.fromEntries(data.fields.flatMap(f => {
      const element = panes.settings.querySelector('#lc-adv-' + f.index);
      const value = f.kind === 'bool' ? element.checked : f.kind === 'int' ? Number(element.value) : element.value;
      return f.kind === 'secret' && !value || value === (f.value ?? '') ? [] : [[f.path, value]];
    }));
    const form = panes.settings.querySelector('form');
    form.oninput = () => panes.settings.querySelector('#lc-dirty').textContent = `Изменено параметров: ${Object.keys(changes()).length}`;
    form.onsubmit = async e => {
      e.preventDefault(); const body = changes(); if (!Object.keys(body).length) return;
      if (await operation('/advanced', body, 'Настройки сохранены. Для модулей может понадобиться перезапуск Lampac.')) {
        for (const f of data.fields) if (Object.hasOwn(body, f.path)) {
          f.value = f.kind === 'secret' ? '' : body[f.path];
          if (f.kind === 'secret') panes.settings.querySelector('#lc-adv-' + f.index).value = '';
        }
        panes.settings.querySelector('#lc-dirty').textContent = 'Изменения сохранены';
      }
    };
    panes.settings.querySelector('#lc-provider-search').oninput = e => {
      const query = e.target.value.toLowerCase().trim();
      panes.settings.querySelectorAll('[data-group]').forEach(group => { group.hidden = !group.dataset.group.includes(query); });
    };
    const client = data.client;
    panes.client.innerHTML = `<form class="card" id="lc-client-form"><h3>Профиль устройств Lampa</h3><p>Каталог, заставка и поведение приложения на ваших устройствах.</p><details><summary>Подключение и применение профиля</summary><p>Применяется через плагин <code>${esc(publicUrl + "/workspace-client.js")}</code>. В Lampa на этом сервере он подключается автоматически после сохранения. В стороннем приложении добавьте этот плагин с адресом вашего Lampac вручную. После изменения профиля перезапустите Lampa; некоторые параметры вступают в силу при следующем запуске интерфейса.</p><p>«На устройстве» не меняет выбранный пользователем параметр. Освобождение ранее управляемого параметра возвращает его прежнее значение, если пользователь не успел изменить его сам.</p></details><label class="voice-field">Режим применения<select id="lc-client-mode">${[['disabled', 'Не управлять настройками устройств'], ['revision', 'Один раз после каждого изменения профиля'], ['always', 'При каждом запуске Lampa']].map(([v, label]) => `<option value="${v}" ${v === client.mode ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="voice-grid">${client.fields.map(f => `<label class="voice-field">${esc(f.label)}<select data-pref="${esc(f.key)}"><option value="">На устройстве</option>${Object.entries(f.options).map(([value, label]) => `<option value="${esc(value)}" ${client.values[f.key] === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`).join('')}</div><button class="save" type="submit">Сохранить профиль Lampa</button></form>`;
    panes.client.querySelector('form').onsubmit = e => {
      e.preventDefault();
      const values = Object.fromEntries([...panes.client.querySelectorAll('[data-pref]')].filter(el => el.value).map(el => [el.dataset.pref, el.value]));
      operation('/client', {mode: panes.client.querySelector('#lc-client-mode').value, values}, 'Профиль сохранён. Перезапустите Lampa на устройствах.');
    };
    settingsLoaded = true;
  }
  async function refresh(force = false) {
    if (!alive || refreshing || tab === 'overview') return;
    // Do not replace a focused input or expanded file list during automatic polling.
    if (!force && (panes[tab].contains(document.activeElement) || panes[tab].querySelector('details[open]') && tab === 'torrents')) return;
    refreshing = true; const active = tab;
    try {
      if (active === 'torrents') { const data = await request('/torrents'); if (alive) renderTorrents(data); }
      else if (active === 'clients') { const data = await request('/clients'); if (alive) renderClients(data); }
      else if (!settingsLoaded) { const data = await request('/advanced'); if (alive) renderSettings(data); }
      if (alive) message.textContent = '';
    } catch (e) { if (alive) message.textContent = e.message; }
    finally { refreshing = false; }
  }
  return {refresh, destroy() { alive = false; }};
};
