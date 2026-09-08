'use strict';
window.LampacPanel=(()=>{
  const root=$('lampac');let timer,loaded=false,pending=false,loading=false,generation=0,advancedPanel;
  const modules=[['TorrServer','TorrServer'],['DLNA','DLNA'],['Sync','Синхронизация закладок'],['TimeCode','Позиция просмотра']];
  const numbers=[['CacheSize','Кеш, МиБ',16,2048],['ConnectionsLimit','Соединения',1,500],['ReaderReadAHead','Чтение вперёд, %',5,100],['PreloadCache','Предзагрузка, %',0,100],['DownloadRateLimit','Загрузка, КБ/с · 0 без лимита',0,1000000],['UploadRateLimit','Отдача, КБ/с · 0 без лимита',0,1000000]];
  const switches=[['DisableUpload','Отключить отдачу'],['DisableDHT','Отключить DHT'],['DisablePEX','Отключить обмен пирами'],['EnableIPv6','Использовать IPv6'],['ForceEncrypt','Шифровать соединения с пирами'],['UseDisk','Хранить кеш на диске'],['RemoveCacheOnDrop','Удалять кеш при удалении торрента']];
  const help={
    name:'Название сервера в клиентской интеграции Lampac.',timeout:'Общий предел ожидания ответа. Источники могут иметь собственный таймаут.',
    lowMemory:'Снижает расход памяти сервером Lampac. При большой одновременной нагрузке может уменьшать производительность.',
    chromium:'Браузерный движок для источников, которым нужен JavaScript или браузерная проверка. Отключение может сделать такие источники недоступными.',
    TorrServer:'Серверный движок воспроизведения торрентов. Клиентский плагин включается отдельно в «Источники и плагины».',
    DLNA:'Медиасервер в локальной сети этого сервера. Через обычный интернет доступность DLNA не гарантируется.',
    Sync:'Серверная синхронизация закладок для поддерживаемых клиентов. Клиентский плагин подключается отдельно.',
    TimeCode:'Серверное сохранение позиции просмотра для продолжения видео в поддерживаемых клиентах.',
    CacheSize:'Объём буфера на торрент в МиБ. Большие значения увеличивают расход памяти или места на диске.',
    ConnectionsLimit:'Предельное количество соединений с пирами; высокое значение увеличивает нагрузку.',
    ReaderReadAHead:'Доля кеша, используемая для чтения вперёд относительно текущей позиции видео.',
    PreloadCache:'Доля буфера, набираемая перед стартом воспроизведения. Большее значение увеличивает начальное ожидание.',
    DownloadRateLimit:'Ограничение скорости загрузки TorrServer в КБ/с. 0 — без ограничения.',
    UploadRateLimit:'Ограничение скорости отдачи TorrServer в КБ/с. 0 — без ограничения; отключённая отдача имеет приоритет.',
    DisableUpload:'Включение этого переключателя запрещает отдачу другим пирам.',
    DisableDHT:'Отключает поиск пиров через распределённую таблицу DHT; источников пиров может стать меньше.',
    DisablePEX:'Отключает обмен списками пиров между участниками торрента.',
    EnableIPv6:'Разрешает соединения по IPv6, если IPv6 доступен на сервере.',
    ForceEncrypt:'Требует шифрования соединений с пирами. Несовместимые пиры могут стать недоступны.',
    UseDisk:'Буфер на диске вместо оперативной памяти. Требуется настроенный на сервере путь хранения и свободное место.',
    RemoveCacheOnDrop:'Удаляет дисковый кеш при выгрузке торрента; действует при использовании дискового кеша.'
  };
  const toggle=(id,label,value,description='')=>`<label class="voice-field voice-toggle" for="lc-${id}"><span>${esc(label)}${description?`<small class="lc-help">${esc(description)}</small>`:''}</span><span class="voice-switch"><input id="lc-${id}" type="checkbox" role="switch" ${value?'checked':''}><span class="voice-switch-track" aria-hidden="true"></span></span></label>`;
  async function request(path='',body){const token=S.token;const r=await fetch('/api/admin/lampac'+path,{method:body?'POST':'GET',headers:{'x-admin-token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(35000)});const d=await r.json();if(token!==S.token)throw Error('Сессия завершена');if(!r.ok)throw Error(d.error||'Ошибка Lampac');return d;}
  function state(d){
    $('lc-state').textContent=({active:d.healthy?'Работает':'Запущен · HTTP пока недоступен',inactive:'Остановлен',failed:'Ошибка запуска',activating:'Запускается',deactivating:'Останавливается'})[d.service.ActiveState]||d.service.ActiveState;
    const memory=Number(d.service.MemoryCurrent);
    $('lc-details').textContent=`Версия ${d.version} · память ${Number.isFinite(memory)?Math.round(memory/1048576)+' МиБ':'—'} · автозапуск ${d.service.UnitFileState==='enabled'?'включён':'выключен'}`;
    $('lc-autostart').textContent=d.service.UnitFileState==='enabled'?'Отключить автозапуск':'Включить автозапуск';
    $('lc-autostart').dataset.action=d.service.UnitFileState==='enabled'?'disable':'enable';
    root.querySelectorAll('[data-action]').forEach(b=>{b.disabled=pending||d.busy;});
  }
  async function operation(path,body,message){if(pending)return;generation++;loading=false;pending=true;const buttons=Array.from(root.querySelectorAll('button'),b=>[b,b.disabled]);buttons.forEach(([b])=>b.disabled=true);const g=generation;try{await request(path,body);if(g!==generation)return;toast(message,'ok');return true;}catch(e){if(g===generation)toast(e.message,'err');}finally{if(g===generation){pending=false;buttons.forEach(([b,disabled])=>{if(b.isConnected)b.disabled=disabled;});await refresh();}}}
  function render(d){
    const c=d.settings;let url='';try{const u=new URL(d.url);if(u.protocol==='https:'&&!u.username&&!u.password)url=u.origin;}catch{}
    root.innerHTML=`<div class="section voice-section"><div class="page-heading"><span class="eyebrow">Медиасервисы</span><h2>Lampac</h2><p>Управление сервером и TorrServer в общем рабочем пространстве.</p></div><div class="card"><strong id="lc-state"></strong><p id="lc-details"></p><div class="voice-actions"><button class="save" data-action="start">Включить</button><button class="danger" data-action="stop">Остановить</button><button class="ghost" data-action="restart">Перезапустить</button><button class="ghost" id="lc-autostart" data-action="enable"></button><button class="ghost" id="lc-refresh">Обновить статус</button></div><p id="lc-error" role="status"></p></div><details class="card"><summary>Адреса подключения</summary><p>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`:'Публичный адрес не задан'}</p><div class="address-row"><span>Плагин Lampac</span><code>${esc(url+'/online.js')}</code></div><div class="address-row"><span>Плагин TorrServer</span><code>${esc(url+'/ts.js')}</code></div><div class="address-row"><span>TorrServer</span><code>${esc(url+'/ts')}</code></div><div class="address-row"><span>Внутренний адрес</span><code>${esc(d.internal)}</code></div><p>HTTPS обслуживает Caddy. DNS и адрес сервера доступны в разделе «Управление → Домены и адреса».</p></details><form id="lc-form" class="card"><h3>Настройки сервера Lampac</h3><details class="lc-pref-group"><summary>Основные параметры и ресурсы</summary><div class="voice-grid"><label class="voice-field">Название<input id="lc-name" maxlength="80" required value="${esc(c.name)}"><small class="lc-help">${help.name}</small></label><label class="voice-field">Таймаут ответа, секунд<input id="lc-timeout" type="number" min="5" max="120" required value="${esc(c.timeout)}"><small class="lc-help">${help.timeout}</small></label>${toggle('lowMemory','Экономить оперативную память',c.lowMemory,help.lowMemory)}${toggle('chromium','Использовать Chromium для источников',c.chromium,help.chromium)}</div></details><details class="lc-pref-group"><summary>Серверные модули</summary><div class="voice-grid">${modules.map(([key,label])=>toggle(key,label,c.modules[key],help[key])).join('')}</div></details><p>Отключение Chromium может ограничить доступность источников. DLNA работает в локальной сети сервера. Настройки сохраняются в ${esc(d.configPath)} с резервной копией. После сохранения перезапустите Lampac для применения всех параметров; это прервёт текущие просмотры.</p><button class="save" type="submit">Сохранить настройки Lampac</button></form><details class="card"><summary>TorrServer · буфер и сеть</summary><p>Настройки читаются из работающего TorrServer. Изменения применяются сразу и могут прервать текущие потоки — после сохранения запустите видео заново. Перезапуск TorrServer занимает около 10–20 секунд и не перезапускает Lampac. Большой кеш расходует память на каждое видео; дисковый кеш занимает место на сервере.</p><button class="ghost" data-action="torr-restart">Перезапустить TorrServer</button><button id="lc-ts-load" class="ghost">Загрузить настройки TorrServer</button><div id="lc-ts"></div></details></div>`;
    root.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>operation('/action',{action:b.dataset.action},'Команда выполнена'));
    $('lc-refresh').onclick=refresh;
    $('lc-form').onsubmit=e=>{e.preventDefault();operation('/configure',{name:$('lc-name').value,timeout:Number($('lc-timeout').value),lowMemory:$('lc-lowMemory').checked,chromium:$('lc-chromium').checked,modules:Object.fromEntries(modules.map(([key])=>[key,$('lc-'+key).checked]))},'Сохранено. Перезапустите Lampac для применения всех параметров.');};
    $('lc-ts-load').onclick=loadTorr;state(d);advancedPanel=window.mountLampacAdvanced({container:root,request,operation,toggle,publicUrl:url});
  }
  async function loadTorr(){const g=generation,button=$('lc-ts-load');button.disabled=true;try{const d=await request('/torrserver');if(g!==generation)return;
    const numeric=([key,label,min,max])=>`<label class="voice-field">${esc(label)}<input id="lc-ts-${key}" type="number" required min="${min}" max="${max}" step="1" value="${esc(key==='CacheSize'?d[key]/1048576:d[key])}"><small class="lc-help">${esc(help[key])}</small></label>`;
    const group=(name,keys)=>`<details class="lc-pref-group"><summary>${esc(name)}</summary><div class="voice-grid">${numbers.filter(([k])=>keys.includes(k)).map(numeric).join('')}${switches.filter(([k])=>keys.includes(k)).map(([key,label])=>toggle('ts-'+key,label,d[key],help[key])).join('')}</div></details>`;
    $('lc-ts').innerHTML=`<form id="lc-ts-form">${group('Буфер и хранение',['CacheSize','ReaderReadAHead','PreloadCache','UseDisk','RemoveCacheOnDrop'])}${group('Скорость и соединения',['ConnectionsLimit','DownloadRateLimit','UploadRateLimit','DisableUpload'])}${group('Поиск пиров и протоколы',['DisableDHT','DisablePEX','EnableIPv6','ForceEncrypt'])}<button class="save" type="submit">Применить настройки TorrServer</button></form>`;
    $('lc-ts-form').onsubmit=e=>{e.preventDefault();const values=Object.fromEntries(numbers.map(([key])=>[key,Number($('lc-ts-'+key).value)*(key==='CacheSize'?1048576:1)]));for(const [key] of switches)values[key]=$('lc-ts-'+key).checked;operation('/torrserver',values,'TorrServer подтвердил настройки.');};
  }catch(e){if(g===generation)$('lc-ts').textContent='TorrServer недоступен. Включите модуль и перезапустите Lampac. '+e.message;}finally{if(g===generation)button.disabled=false;}}
  async function refresh(){if(pending||loading||document.hidden||S.view!=='lampac')return;loading=true;const g=generation;try{const d=await request();if(g!==generation||pending)return;if(!loaded){render(d);loaded=true;}else{state(d);$('lc-error').textContent='';}advancedPanel?.refresh();}catch(e){if(g===generation){if(!loaded){root.innerHTML='<div class="section"><h2>Lampac</h2><p id="lc-error" role="status"></p></div>';} $('lc-error').textContent=e.message;}}finally{if(g===generation)loading=false;}}
  function pause(){clearInterval(timer);timer=null;}
  function reset(){pause();advancedPanel?.destroy();advancedPanel=null;generation++;loaded=false;loading=false;pending=false;root.textContent='';}
  function open(){if(!S.permissions.canManageSettings)return;refresh();if(!timer)timer=setInterval(refresh,5000);}
  socket.on('disconnect',reset);socket.on('admin_auth_ok',()=>{reset();if(S.view==='lampac')open();});socket.on('admin_settings_forbidden',reset);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
  window.addEventListener('online',refresh);
  return {open,pause,reset};
})();
