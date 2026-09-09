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
  const tabs = [['overview', 'Сервер'], ['playback', 'Просмотры'], ['torrents', 'Торренты'], ['clients', 'Подключения'], ['devices', 'Устройства'], ['announcements','Объявления'], ['settings', 'Источники и плагины'], ['client', 'Общие настройки']];
  const panes = {};
  for (const [key, label] of tabs) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'ghost'; button.textContent = label;
    button.setAttribute('aria-pressed', String(key === tab));
    navigation.append(button);
    panes[key] = key === 'overview' ? overview : document.createElement('div');
    if (key !== 'overview') content.append(panes[key]);
    panes[key].hidden = key !== tab;
    panes[key].dataset.lcPane = key;
    button.onclick = () => {
      tab = key;
      const descriptions = {
        overview:'Состояние сервисов, подключения и настройки сервера.',
        playback:'Текущие сеансы и последняя ошибка. Обновление каждые 5 секунд; сведения присылает плеер устройства.',
        torrents:'Активные потоки TorrServer, скорость и буфер. Данные обновляются автоматически.',
        clients:'История запросов к Lampac и блокировка внешних IP-адресов.',
        devices:'Доступ и индивидуальные настройки установок Lampa. Новые устройства требуют активации.',
        announcements:'Сообщения на экранах устройств: создание, получатели и состояние доставки.',
        settings:'Параметры источников, плагинов и каталога. Сохраняются только изменённые значения.',
        client:'Единый профиль Lampa для всех устройств. Индивидуальные настройки имеют приоритет.'
      };
      heading.querySelector('h2').textContent = 'Lampac · ' + label;
      heading.querySelector('p').textContent = descriptions[key];
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
  function replaceRecords(pane, html) {
    // A refreshed device or connection keeps its expanded controls in place.
    const key = details => {
      const record=details.closest('[data-record-key]');
      if(!record)return null;
      return record.dataset.recordKey + ':' + (details===record?'root':[...record.querySelectorAll('details')].indexOf(details));
    };
    const opened=new Set([...pane.querySelectorAll('details[open]')].map(key).filter(Boolean));
    pane.innerHTML=html;
    for(const details of pane.querySelectorAll('details'))if(opened.has(key(details)))details.open=true;
  }
  const message = document.createElement('p'); message.setAttribute('role', 'status'); section.append(message);
  function renderTorrents(data) {
    const list = data.torrents || [];
    panes.torrents.innerHTML = `<div class="card"><h3>Торренты · ${list.length}</h3><p>Состояние, буфер и скорости · обновление каждые 5 секунд.</p><div class="wk-note"><p>«Сбросить поток» выгружает торрент из памяти; сохранённая запись остаётся. «Удалить» удаляет запись и кеш. Обе команды могут прервать просмотр.</p><p>Размер буфера — не процент скачивания файла: TorrServer загружает нужные части видео.</p></div></div><div class="lc-list">${list.map((t, index) => `<article class="card lc-torrent"><h3>${esc(t.title || t.name || t.hash)}</h3><p>${esc(status[t.stat] || 'Состояние неизвестно')}</p><div class="lc-metrics"><span>Размер <strong>${bytes(t.torrent_size)}</strong></span><span>В буфере <strong>${bytes(t.loaded_size)}</strong></span><span>Загрузка <strong>${bytes(t.download_speed || 0)}/с</strong></span><span>Отдача <strong>${bytes(t.upload_speed || 0)}/с</strong></span><span>Пиры <strong>${esc(t.active_peers || 0)}</strong></span><span>Сиды <strong>${esc(t.connected_seeders || 0)}</strong></span></div><code>${esc(t.hash)}</code>${t.files?.length ? `<details><summary>Файлы · ${t.files.length}</summary>${t.files.map(f => `<p>${esc(f.path)} · ${bytes(f.length)}</p>`).join('')}</details>` : ''}<div class="voice-actions"><button class="ghost" data-drop="${index}">Сбросить поток</button><button class="danger" data-remove="${index}">Удалить торрент</button></div></article>`).join('') || empty('Торрентов пока нет. Они появятся после запуска видео через TorrServer.')}</div>`;
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
    replaceRecords(panes.clients, `<p class="wk-note">Последние ${data.limit || 500} записей за ${data.retentionDays || 7} дней. IP и браузер — подключение, а не ID устройства. «Недавно» — запрос за 2 минуты, не подтверждение просмотра.</p><div class="card"><form class="wk-inline-form" id="lc-block-form"><label class="voice-field">IP для блокировки<input id="lc-block-ip" required maxlength="45" placeholder="IPv4 или IPv6" autocomplete="off"></label><button class="danger" type="submit">Заблокировать IP</button></form><div id="lc-blocked">${blocked.map((ip, i) => `<p><code>${esc(ip)}</code> <button class="ghost" data-unblock="${i}">Разблокировать</button></p>`).join('')}</div><p class="wk-note">Блокировка действует на весь IP: несколько устройств могут потерять доступ. Уже открытый поток можно сбросить во вкладке «Торренты».</p></div><div class="lc-list lc-record-list">${list.map((c, i) => `<details class="card lc-record" data-record-key="${esc(c.ip+'|'+(c.ua||''))}"><summary><span>${esc(c.ip)}</span><small class="wk-badge">${blocked.includes(c.ip) ? 'Заблокирован' : Date.now() / 1000 - c.last < 120 ? 'Недавно' : 'Неактивен'}</small></summary><div class="lc-record-body"><p>${esc(c.ua || 'Браузер не передал сведения')}</p><p>Последний запрос: ${esc(date(c.last))} · ${esc(c.route)}<br>Первый запрос: ${esc(date(c.first))} · обращений: ${esc(c.requests)}</p>${c.torrent ? `<p>Последний хеш торрента: <code>${esc(c.torrent)}</code></p>` : ''}<footer class="wk-actions"><button class="${blocked.includes(c.ip) ? 'ghost' : 'danger'}" data-client-block="${i}">${blocked.includes(c.ip) ? 'Разблокировать' : 'Заблокировать IP'}</button></footer></div></details>`).join('') || empty('Пока нет обращений. Откройте Lampa или запустите видео через публичный адрес.')}</div>`);
    const block = async (ip, value) => {
      if (value && !confirm(`Заблокировать ${ip}? Доступ потеряют все устройства с этим внешним IP.`)) return;
      await operation('/clients', {ip, blocked: value}, value ? 'IP заблокирован' : 'IP разблокирован'); refresh(true);
    };
    panes.clients.querySelector('#lc-block-form').onsubmit = e => { e.preventDefault(); block(panes.clients.querySelector('#lc-block-ip').value.trim(), true); };
    panes.clients.querySelectorAll('[data-unblock]').forEach(b => b.onclick = () => block(blocked[Number(b.dataset.unblock)], false));
    panes.clients.querySelectorAll('[data-client-block]').forEach(b => b.onclick = () => { const ip = list[Number(b.dataset.clientBlock)].ip; block(ip, !blocked.includes(ip)); });
  }
  function preferences(fields, values, snapshot, global = false, shared = {}) {
    const groups = new Map();
    fields.forEach(f => {const group = f.group || 'Настройки'; if (!groups.has(group)) groups.set(group, []); groups.get(group).push(f);});
    const renderGroup=([group, items]) => `<details class="lc-pref-group"><summary>${esc(group)} <small>${items.length}</small></summary>${items.map(f => {
      const managed = Object.hasOwn(values, f.key), value = values[f.key] ?? shared[f.key] ?? snapshot[f.key] ?? f.default ?? Object.keys(f.options)[0];
      const bool = Object.keys(f.options).length === 2 && 'true' in f.options && 'false' in f.options;
      return `<div class="lc-pref-row" data-pref-label="${esc((f.label+' '+group+' '+(f.description||'')).toLowerCase())}" data-key="${esc(f.key)}"><div><strong>${esc(f.label)}</strong><p class="lc-help">${esc(f.description||'Параметр приложения Lampa.')}</p>${global?'':`<small>${Object.hasOwn(shared,f.key)?'Общий профиль: '+esc(f.options[shared[f.key]]||shared[f.key])+' · ':''}${Object.hasOwn(snapshot,f.key)?'Значение Lampa: '+esc(f.options[snapshot[f.key]]||snapshot[f.key]):'Без своего значения — общий профиль или настройка Lampa'}</small>`}</div><div class="lc-pref-controls"><label class="lc-mini-switch"><span>${global?'Задать для всех':'Своё значение'}</span><span class="voice-switch"><input type="checkbox" role="switch" aria-label="${esc((global?'Задать для всех: ':'Своё значение: ')+f.label)}" data-managed ${managed?'checked':''}><span class="voice-switch-track" aria-hidden="true"></span></span></label>${bool?`<label class="lc-mini-switch"><span>${f.visibility?'Показывать':'Включено'}</span><span class="voice-switch"><input type="checkbox" role="switch" aria-label="${esc(f.label)}" data-value ${value==='true'?'checked':''} ${managed?'':'disabled'}><span class="voice-switch-track" aria-hidden="true"></span></span></label>`:`<label class="voice-field"><span class="sr-only">${esc(f.label)}</span><select data-value ${managed?'':'disabled'}>${Object.entries(f.options).map(([v,l])=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`}</div></div>`;
    }).join('')}</details>`;
    const families=new Map();
    for(const entry of groups){const g=entry[0],family=g==='Видимость · Верхняя панель'||g==='Видимость · Левое меню'?'Меню и верхняя панель':g.startsWith('Видимость')?'Доступ к настройкам':['Каталог','Плеер','Субтитры','Поиск торрентов','Торренты · клиент','Сеть клиента'].includes(g)?'Каталог и воспроизведение':'Оформление и интерфейс';if(!families.has(family))families.set(family,[]);families.get(family).push(entry);}
    return [...families].map(([family,entries],i)=>`<details class="lc-pref-family"><summary>${esc(family)} <small>${entries.reduce((n,e)=>n+e[1].length,0)}</small></summary><div class="lc-pref-family-body">${entries.map(renderGroup).join('')}</div></details>`).join('');
  }
  function bindPreferences(form) {
    form.querySelectorAll('[data-managed]').forEach(el=>el.onchange=()=>{el.closest('[data-key]').querySelector('[data-value]').disabled=!el.checked;const group=el.closest('.lc-pref-group');group.querySelector('summary small').textContent=group.querySelectorAll('[data-key]').length;});
    const search=form.querySelector('[data-pref-search]');
    if(search)search.oninput=()=>{const query=search.value.toLowerCase().trim();form.querySelectorAll('.lc-pref-group').forEach(group=>{let found=false;group.querySelectorAll('[data-pref-label]').forEach(row=>{row.hidden=!row.dataset.prefLabel.includes(query);found ||= !row.hidden;});group.hidden=!found;if(query&&found)group.open=true;});form.querySelectorAll('.lc-pref-family').forEach(family=>{family.hidden=![...family.querySelectorAll('.lc-pref-group')].some(g=>!g.hidden);if(query&&!family.hidden)family.open=true;});};
  }
  function preferenceChanges(form, previous) {
    const values={},inherit=[];
    form.querySelectorAll('[data-key]').forEach(row=>{const key=row.dataset.key, managed=row.querySelector('[data-managed]').checked, input=row.querySelector('[data-value]'),value=input.type==='checkbox'?String(input.checked):input.value;
      if(managed&&previous[key]!==value)values[key]=value;
      if(!managed&&Object.hasOwn(previous,key))inherit.push(key);
    });return {values,inherit};
  }
  function renderDevices(data) {
    replaceRecords(panes.devices, `<p class="wk-note">Устройства регистрируются автоматически через <code>${esc(publicUrl + '/workspace-client.js')}</code>. ID относится к установке Lampa и меняется после очистки её данных.</p><div class="wk-list-heading"><span>Устройство</span><span>Состояние</span></div><div class="lc-list lc-record-list">${data.devices.map((d, i) => `<details class="card lc-record" data-record-key="${esc(d.id)}"><summary><span>${esc(d.name)}</span><small class="wk-badge" data-device-presence="${esc(d.id)}">${d.enabled===0?'Ожидает доступа':Date.now()/1000-d.last<90?'На связи':'Нет свежего сигнала'}</small></summary><div class="lc-record-body"><dl class="wk-metadata"><div><dt>ID установки</dt><dd><code>${esc(d.id)}</code></dd></div><div><dt>IP-адрес</dt><dd>${esc(d.ip)}</dd></div><div><dt>Последний ответ</dt><dd data-device-last="${esc(d.id)}">${esc(date(d.last))}</dd></div><div><dt>Профиль</dt><dd>${d.applied < d.revision ? 'Ожидает применения' : 'Изменения подтверждены'}</dd></div></dl><form data-rename-form="${i}" class="wk-inline-form"><label class="voice-field">Название устройства<input name="deviceName" required maxlength="80" value="${esc(d.name)}"></label><button class="ghost">Переименовать</button></form><details class="lc-device-settings"><summary>Настройки устройства</summary><form data-device-form="${i}"><p class="wk-note">Значения устройства перекрывают общий профиль при каждом запуске. «Общий профиль» возвращает наследование.</p><label class="voice-field">Найти настройку<input type="search" data-pref-search placeholder="Например, меню или плеер"></label>${preferences(data.fields.filter(f=>!f.key.startsWith('workspace_ui_')||!Array.isArray(d.controls)||d.controls.includes(f.key)||Object.hasOwn(d.desired||{},f.key)),d.desired||{},d.snapshot||{},false,data.shared||{})}${toggle('device-reload-'+i,'Перезапустить Lampa после применения · прервёт просмотр',false)}<div class="wk-actions"><button class="save" ${d.applied < d.revision ? 'disabled' : ''}>Сохранить профиль</button></div></form></details><footer class="wk-actions wk-record-actions"><button class="${d.enabled===0?'save':'ghost'}" data-access="${i}">${d.enabled===0?'Включить доступ':'Отключить доступ'}</button><button class="danger" data-revoke="${i}">Удалить устройство</button></footer></div></details>`).join('') || empty('Запустите Lampa с плагином Workspace: устройство появится автоматически.')}</div>`);
    panes.devices.querySelectorAll('[data-rename-form]').forEach(form=>form.onsubmit=async e=>{e.preventDefault();if(await operation('/devices',{action:'rename',id:data.devices[Number(form.dataset.renameForm)].id,name:form.elements.deviceName.value.trim()},'Устройство переименовано'))refresh(true);});
    panes.devices.querySelectorAll('[data-access]').forEach(button=>button.onclick=async()=>{const d=data.devices[Number(button.dataset.access)];if(d.enabled!==0&&!confirm('Отключить доступ «'+d.name+'»? Его настройки сохранятся.'))return;if(await operation('/devices',{action:'access',id:d.id,enabled:d.enabled===0},d.enabled===0?'Доступ включён':'Доступ отключён'))refresh(true);});
    panes.devices.querySelectorAll('[data-device-form]').forEach(form=>{bindPreferences(form);});
    panes.devices.querySelectorAll('[data-device-form]').forEach(form=>form.onsubmit=async e=>{
      e.preventDefault();const i=Number(form.dataset.deviceForm),d=data.devices[i];
      const {values,inherit}=preferenceChanges(form,d.desired||{});
      const reload=form.querySelector('#lc-device-reload-'+i).checked;
      if(reload&&!confirm('Перезапустить Lampa на этом устройстве после применения? Просмотр будет прерван.'))return;
      if(await operation('/devices',{action:'configure',id:d.id,values,reload,inherit},'Команда поставлена в очередь. Ожидается ответ устройства.'))refresh(true);
    });
    panes.devices.querySelectorAll('[data-revoke]').forEach(button=>button.onclick=async()=>{
      const d=data.devices[Number(button.dataset.revoke)];if(!confirm('Удалить устройство «'+d.name+'»? Профиль будет удалён, доступ закрыт. При повторном подключении оно появится заново и потребует активации.'))return;
      if(await operation('/devices',{action:'revoke',id:d.id},'Доступ отозван'))refresh(true);
    });
  }
  function renderAnnouncements(data) {
    const previous=panes.announcements.querySelector('form'),draft=previous?Object.fromEntries([...previous.elements].filter(el=>el.name).map(el=>[el.name,el.value])):null;
    const composeOpen=!!panes.announcements.querySelector('.lc-compose[open]');
    const optionsOpen=!!panes.announcements.querySelector('.lc-announcement-options[open]');
    const list=data.announcements||[];
    panes.announcements.innerHTML=`<details class="card lc-compose"><summary>Новое объявление</summary><form id="lc-announcement-form"><p>Большое окно с логотипом поверх Lampa. Устройства не в сети получат его после подключения и активации. «Все» — устройства, добавленные к моменту отправки.</p><div class="voice-grid"><label class="voice-field">Получатели<select name="target"><option value="all">Все устройства · ${data.devices.length}</option>${data.devices.map(d=>`<option value="${esc(d.id)}">${esc(d.name)} · ${esc(d.id.slice(-6))}</option>`).join('')}</select></label><label class="voice-field">Заголовок<input name="title" required maxlength="120" placeholder="Важная информация"></label></div><label class="voice-field">Текст объявления<textarea name="message" required maxlength="5000" rows="3" placeholder="Напишите объявление. Переносы строк сохранятся."></textarea></label><details class="lc-announcement-options"><summary>Кнопка и повторы</summary><div class="voice-grid"><label class="voice-field">Текст кнопки закрытия<input name="button" required maxlength="60" value="Понятно"></label><label class="voice-field">Показов каждому устройству<input name="repeats" type="number" min="1" max="100" step="1" value="1" required></label><label class="voice-field">Интервал между показами, минут<input name="intervalMinutes" type="number" min="1" max="10080" step="1" value="60" required></label></div><p class="lc-help">Показ учитывается при открытии окна, отдельно для каждого устройства. Повтор не откроется, пока пользователь не закроет предыдущее окно. Длинный текст можно листать стрелками пульта; Enter или «Назад» закрывает окно.</p></details><div class="wk-actions wk-form-footer"><button class="save" ${data.devices.length?'':'disabled'}>Отправить объявление</button></div></form></details><div class="lc-list lc-record-list">${list.map((a,i)=>`<details class="card lc-record"><summary><span>${esc(a.title)}</span><small>${a.cancelled?'Остановлено':a.shown>=a.recipients*a.repeats?'Доставлено':'Доставляется'}</small></summary><div class="lc-record-body"><p>${a.cancelled?'Дальнейшие показы остановлены':a.shown>=a.recipients*a.repeats?'Все показы подтверждены':'Доставляется'} · ${esc(date(a.created))}</p><p>Показано ${a.shown} из ${a.recipients*a.repeats} · устройств: ${a.recipients}<br>Каждому: ${a.repeats} · интервал: ${a.interval_seconds/60} мин.</p><details><summary>Текст и кнопка</summary><p style="white-space:pre-wrap">${esc(a.message)}</p><p>Кнопка: ${esc(a.button)}</p></details>${!a.cancelled&&a.shown<a.recipients*a.repeats?`<button class="ghost" data-stop-announcement="${i}">Остановить дальнейшие показы</button>`:''}</div></details>`).join('')||empty('Объявлений пока нет.')}</div>`;
    panes.announcements.querySelector('.lc-compose').open=composeOpen;
    panes.announcements.querySelector('.lc-announcement-options').open=optionsOpen;
    const form=panes.announcements.querySelector('form');
    form.addEventListener('invalid',e=>{let node=e.target.parentElement;while(node&&node!==form){if(node.tagName==='DETAILS')node.open=true;node=node.parentElement;}},true);
    if(draft)Object.entries(draft).forEach(([k,v])=>{form.elements[k].value=v;});
    form.elements.repeats.oninput=()=>{form.elements.intervalMinutes.disabled=Number(form.elements.repeats.value)===1;};form.elements.repeats.oninput();
    form.onsubmit=async e=>{e.preventDefault();const body={action:'announce',target:form.elements.target.value,title:form.elements.title.value.trim(),message:form.elements.message.value.trim(),button:form.elements.button.value.trim(),repeats:Number(form.elements.repeats.value),intervalMinutes:Number(form.elements.repeats.value)===1?60:Number(form.elements.intervalMinutes.value)};
      const recipient=body.target==='all'?`всем ${data.devices.length} устройствам`:form.elements.target.selectedOptions[0].textContent;
      if(!confirm(`Отправить «${body.title}» ${recipient}? Показы каждому: ${body.repeats}.`))return;
      if(await operation('/devices',body,'Объявление отправлено. Ожидаются показы на устройствах.')){form.reset();refresh(true);}
    };
    panes.announcements.querySelectorAll('[data-stop-announcement]').forEach(button=>button.onclick=async()=>{if(await operation('/devices',{action:'announcement-cancel',id:list[Number(button.dataset.stopAnnouncement)].id},'Дальнейшие показы остановлены. Уже открытое окно пользователь закроет кнопкой.'))refresh(true);});
  }
  function renderSettings(data) {
    const groups = new Map();
    data.fields.forEach((f, index) => { f.index = index; if (!groups.has(f.group)) groups.set(f.group, []); groups.get(f.group).push(f); });
    const input = f => `<div data-field-search="${esc((f.label+' '+f.group+' '+f.description).toLowerCase())}">`+(f.kind === 'bool' ? toggle('adv-' + f.index, f.label, f.value) : `<label class="voice-field">${esc(f.label)}${f.kind === 'secret' && f.configured ? ' · задан' : ''}<input id="lc-adv-${f.index}" type="${f.kind === 'int' ? 'number' : f.kind === 'secret' ? 'password' : f.kind === 'url' ? 'url' : 'text'}" ${f.kind === 'int' ? `min="${f.min}" max="${f.max}" step="1" required` : 'maxlength="2048"'} value="${esc(f.value ?? '')}" autocomplete="off"></label>`)+`<p class="lc-help">${esc(f.description)}</p></div>`;
    panes.settings.innerHTML = `<form id="lc-advanced-form"><div class="card"><h3>Источники, плагины и сервер</h3><p class="wk-note">Показаны параметры, которые есть в текущей версии Lampac. Сохраняются только ваши изменения; скрытые настройки и токены сохраняются. Прокси источника использует ранее настроенный прокси Lampac. Изменение адреса источника может потребовать другой токен.</p><label class="voice-field">Поиск источника или раздела<input id="lc-provider-search" type="search" placeholder="Например, Filmix или плагины"></label><div class="wk-actions wk-form-footer"><p id="lc-dirty" role="status">Нет изменений</p><button class="save" type="submit">Сохранить изменения</button></div></div>${[...groups].map(([group, fields]) => `<details class="card lc-config-group" data-group="${esc(group.toLowerCase())}" ><summary>${esc(group)} <small class="summary-count">${fields.length}</small></summary><div class="voice-grid">${fields.map(input).join('')}</div></details>`).join('')}</form>`;
    const changes = () => Object.fromEntries(data.fields.flatMap(f => {
      const element = panes.settings.querySelector('#lc-adv-' + f.index);
      const value = f.kind === 'bool' ? element.checked : f.kind === 'int' ? Number(element.value) : element.value;
      return f.kind === 'secret' && !value || value === (f.value ?? '') ? [] : [[f.path, value]];
    }));
    const form = panes.settings.querySelector('form');
    form.oninput = () => panes.settings.querySelector('#lc-dirty').textContent = `Изменено параметров: ${Object.keys(changes()).length}`;
    form.onsubmit = async e => {
      e.preventDefault(); const body = changes(); if (!Object.keys(body).length) { panes.settings.querySelector('#lc-dirty').textContent = 'Нет изменений для сохранения'; return; }
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
      panes.settings.querySelectorAll('[data-group]').forEach(group => {let found=false;group.querySelectorAll('[data-field-search]').forEach(row=>{row.hidden=!row.dataset.fieldSearch.includes(query);found ||= !row.hidden;});group.hidden=!found;if(query&&found)group.open=true;});
    };
    const client = data.client;
    const commonFields=client.fields.filter(f=>f.global);
    panes.client.innerHTML = `<form class="card" id="lc-client-form"><h3>Общие настройки Lampa</h3><div class="wk-note"><p>Единый профиль для всех устройств: оформление, поведение и видимость пунктов. Переключатели в группах «Видимость» управляют доступом к настройке в Lampa, остальные — её значением. Списки отдельных настроек и меню собираются с подключённых устройств после обновления Lampa. Можно включить один пункт внутри выключенного раздела — например, очистку кеша. В карточке устройства можно переопределить любой параметр. Индивидуальное значение имеет приоритет.</p><p class="lc-help">«Задать для всех» включает управление параметром. При выключении Lampa использует своё значение; индивидуальные профили сохраняются. Чтобы закрыть раздел настроек, включите управление и выключите его доступность. Workspace на устройстве показывает только информацию.</p></div><label class="voice-field">Режим применения<select id="lc-client-mode">${[['disabled','Не применять общий профиль'],['revision','После изменения профиля'],['always','При каждом запуске']].map(([v,l])=>`<option value="${v}" ${v===client.mode?'selected':''}>${l}</option>`).join('')}</select></label><label class="voice-field">Найти пункт настройки или меню<input type="search" data-pref-search placeholder="Например, кеш или избранное"></label>${preferences(commonFields,client.values,{},true)}<div class="voice-actions"><button class="save">Сохранить общие настройки</button><button type="button" class="ghost" data-refresh-controls>Обновить список пунктов</button></div></form>`;
    const commonForm=panes.client.querySelector('form');bindPreferences(commonForm);
    commonForm.querySelector('[data-refresh-controls]').onclick=async()=>{const dirty=preferenceChanges(commonForm,client.values);if(Object.keys(dirty.values).length||dirty.inherit.length||commonForm.querySelector('#lc-client-mode').value!==client.mode){message.textContent='Сначала сохраните изменения общего профиля.';return;}try{const next=await request('/advanced');if(alive){renderSettings(next);message.textContent='Список пунктов обновлён.';}}catch(e){if(alive)message.textContent=e.message;}};
    commonForm.onsubmit=async e=>{e.preventDefault();const changes=preferenceChanges(commonForm,client.values),values={...client.values,...changes.values};changes.inherit.forEach(k=>delete values[k]);
      if(await operation('/client',{mode:panes.client.querySelector('#lc-client-mode').value,values},'Общие настройки сохранены. Перезапустите Lampa.')){client.values=values;client.mode=panes.client.querySelector('#lc-client-mode').value;}
    };
    settingsLoaded = true;
  }
  panes.playback.addEventListener('error',event=>{if(event.target.matches('.lc-session-poster img'))event.target.hidden=true;},true);
  const playbackStates={idle:'Lampa открыта',loading:'Загрузка',playing:'Смотрит',paused:'Пауза',buffering:'Буферизация',ended:'Просмотр завершён',error:'Ошибка плеера'};
  const playbackErrors={aborted:'Воспроизведение прервано',network:'Ошибка загрузки потока',decode:'Ошибка декодирования',unsupported:'Формат или источник не поддерживается',player:'Ошибка плеера без подробностей'};
  const seconds=n=>n==null?'Недоступно':Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');
  function presence(device,sessions,now){
    if(!device.enabled)return 'Ожидает доступа';
    const current=sessions.find(s=>s.device===device.id&&s.fresh&&['playing','buffering','loading','paused'].includes(s.state));
    return current?playbackStates[current.state]:now-device.last<90?'На связи':'Нет свежего сигнала';
  }
  function updatePresence(data){
    panes.devices.querySelectorAll('[data-device-presence]').forEach(node=>{const d=data.devices.find(d=>d.id===node.dataset.devicePresence);if(d)node.textContent=presence(d,data.sessions,data.serverTime);});
    panes.devices.querySelectorAll('[data-device-last]').forEach(node=>{const d=data.devices.find(d=>d.id===node.dataset.deviceLast);if(d)node.textContent=date(d.last);});
  }
  function posterMarkup(value){
    const safe=typeof value==='string'&&/^https:\/\/(image\.tmdb\.org\/t\/p\/w300|st\.kp\.yandex\.net|kinopoiskapiunofficial\.tech)\/[a-zA-Z0-9/_-]+\.(jpg|png|webp)$/.test(value);
    return `<div class="lc-session-poster"><span aria-hidden="true">▧</span>${safe?`<img src="${esc(value)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`:''}</div>`;
  }
  function renderPlayback(data){
    const records=data.sessions.filter(s=>s.state!=='idle');
    const row=(label,value)=>`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
    panes.playback.innerHTML=`<p class="wk-note">Проверено ${esc(date(data.serverTime))}. Без сигнала более 90 секунд статус просмотра не подтверждён. Внешний плеер может не передавать данные. Скорость TorrServer относится ко всей раздаче, буфер — к этому плееру. Последние сведения хранятся до 24 часов.${data.torrentsAvailable?'':' Скорость TorrServer сейчас недоступна.'}</p><div class="lc-list lc-record-list">${records.map(s=>`<article class="card lc-session">${posterMarkup(s.poster)}<div class="lc-session-content"><div class="lc-session-device"><span>${esc(s.name)}</span> <small class="wk-badge">${esc(!s.enabled?'Доступ отключён':s.fresh?playbackStates[s.state]:'Статус не подтверждён')}</small></div><h3 class="lc-session-title">${esc(s.title||'Название не передано')}</h3><dl class="wk-metadata">${row('Источник',(s.hash?'Торрент · ':'')+(s.source||'Не передан'))}${row('Способ',({'browser':'Встроенный · браузер','browser-hls':'Встроенный · HLS','native':'Встроенный · система устройства'})[s.method]||'Не определён')}${row('Позиция',seconds(s.position)+' / '+seconds(s.duration))}${row('Буфер плеера',s.fresh&&s.buffer!=null?s.buffer+' с':'Недоступно')}${row('Скорость раздачи',s.fresh&&s.downloadSpeed!=null?bytes(s.downloadSpeed)+'/с':'Недоступно')}${row('Последний сигнал',date(s.updated))}${row('Последняя ошибка',playbackErrors[s.error]||'Не зарегистрирована')}</dl></div></article>`).join('')||empty('Сеансов пока нет. После обновления плагина перезапустите Lampa и включите фильм.')}</div>`;
  }
  async function refresh(force = false) {
    if (!alive || refreshing || tab === 'overview') return;
    // Do not replace a focused input or expanded file list during automatic polling.
    const editing=!force&&(panes[tab].contains(document.activeElement)||panes[tab].querySelector('details[open]'));
    if(editing&&!['devices','playback'].includes(tab))return;
    refreshing = true; const active = tab;
    try {
      if (active === 'playback') {const data=await request('/playback');if(alive)renderPlayback(data);}
      else if (active === 'announcements') {const data=await request('/devices');if(alive)renderAnnouncements(data);}
      else if (active === 'devices') { if(!editing){const data=await request('/devices');if(alive)renderDevices(data);}const live=await request('/playback');if(alive)updatePresence(live); }
      else if (active === 'torrents') { const data = await request('/torrents'); if (alive) renderTorrents(data); }
      else if (active === 'clients') { const data = await request('/clients'); if (alive) renderClients(data); }
      else if (!settingsLoaded) { const data = await request('/advanced'); if (alive) renderSettings(data); }
      if (alive) message.textContent = '';
    } catch (e) { if (alive) message.textContent = e.message; }
    finally { refreshing = false; }
  }
  return {refresh, destroy() { alive = false; }};
};
