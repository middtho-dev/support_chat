'use strict';
// Each new tool registers one section here and provides its own panel and API.
window.AdminShell = (() => {
  const modules = [
    { id: 'home', label: 'Обзор', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
    { id: 'chat', label: 'Поддержка', description: 'Диалоги с клиентами, сообщения и история обращений.', icon: 'M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z' },
    { id: 'frp', label: 'Устройства', description: 'Удалённый доступ, веб-интерфейсы и управление FRP.', manager: true, icon: 'M3 4h18v12H3zM8 21h8M12 16v5M6 8h2M6 12h4' },
    { id: 'voice', label: 'Аудио', description: 'Расшифровка голосовых Telegram и оформление текста через OpenAI.', manager: true, icon: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8' },
    { id: 'lampac', label: 'Lampac', description: 'Медиасервер, TorrServer, буфер и сетевые настройки.', manager: true, icon: 'M3 4h18v14H3zM10 8l5 3-5 3zM8 22h8' },
    { id: 'templates', label: 'Шаблоны', description: 'Готовые ответы для поддержки. Сохраняются в этом браузере.', icon: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5' },
    { id: 'settings', label: 'Управление', description: 'Состояние системы, операторы и настройки поддержки.', icon: 'M4 7h16M4 17h16M8 4v6M16 14v6' }
  ];
  const icon = m => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${m.icon}"/></svg>`;
  document.querySelector('.rail').innerHTML = modules.map(m => `<button type="button" class="navbtn" data-view="${m.id}" aria-label="${m.label}" title="${m.label}" ${m.manager ? 'hidden' : ''}>${icon(m)}<span>${m.label}</span></button>`).join('');
  let current, cache={}, timer=null, busy=false, generation=0, identity='', mounted='', controller=null;
  const sources={health:'/api/admin/health',frp:'/api/admin/frp',voice:'/api/admin/voice',lampac:'/api/admin/lampac',torrents:'/api/admin/lampac/torrents',devices:'/api/admin/lampac/devices'};
  const number=n=>Number.isFinite(Number(n))?Number(n):0;
  const bytes=n=>Number.isFinite(Number(n))?(Number(n)/1073741824).toLocaleString('ru-RU',{maximumFractionDigits:1})+' ГиБ':'—';
  function cardData(key) {
    const entry=cache[key];
    if(!entry)return {state:'unknown',label:'Проверяется',details:[]};
    if(entry.error&&!entry.data)return {state:'error',label:'Нет данных',details:[entry.error],at:entry.at};
    const d=entry.data, result={state:'ok',label:'Работает',details:[],at:entry.at};
    if(key==='health')result.details=['Версия '+(d.version||'—'),'Без перезапуска: '+Math.floor(number(d.uptime)/3600)+' ч '+Math.floor(number(d.uptime)%3600/60)+' мин','Realtime: '+number(d.realtime?.connectedClients)+' подключений'];
    if(key==='frp'){result.state=d.monitoringError||d.error?'error':d.running?'ok':'warning';result.label=d.monitoringError?'Мониторинг недоступен':d.running?'Запущен':'Остановлен';result.details=['Клиенты в сети: '+(d.monitoringError?'—':(d.clients||[]).filter(x=>x.online).length),'Туннели: '+(d.devices||[]).length,'Версия '+(d.version||'—'),d.monitoringError||d.error].filter(Boolean);}
    if(key==='voice'){const jobs=d.jobs||[];result.state=d.error?'error':d.config?.enabled?'ok':'warning';result.label=d.error?'Ошибка':d.config?.enabled?(d.busy?'Обрабатывает':'Ожидает задания'):'Выключен';result.details=['Сегодня: '+Math.ceil(number(d.todaySeconds)/60)+' / '+number(d.config?.dailyMinutes)+' мин','В последних 30 заданиях: '+jobs.filter(j=>['pending','ready','sending','cleanup'].includes(j.status)).length+' незавершённых, '+jobs.filter(j=>['failed','uncertain'].includes(j.status)).length+' с ошибками','VPN: '+(d.config?.vpnEnabled?(d.vpn?.running?'запущен':'не запущен'):'выключен'),d.error].filter(Boolean);}
    if(key==='lampac'){result.state=d.healthy?'ok':'error';result.label=d.healthy?'Доступен':d.service?.ActiveState==='active'?'HTTP недоступен':'Остановлен';result.details=['Версия '+(d.version||'—'),'Память: '+bytes(d.service?.MemoryCurrent),'Автозапуск: '+(d.service?.UnitFileState==='enabled'?'да':'нет')];}
    if(key==='torrents'){const list=d.torrents||[];result.details=['Торрентов: '+list.length,'Работают: '+list.filter(t=>t.stat===3).length,'Буфер: '+bytes(list.reduce((n,t)=>n+number(t.loaded_size),0)),'Загрузка: '+(list.reduce((n,t)=>n+number(t.download_speed),0)/1048576).toFixed(1)+' МиБ/с'];}
    if(key==='devices'){const list=d.devices||[],pending=list.filter(x=>x.enabled===0).length;result.state=pending?'warning':'ok';result.label=pending?'Ожидают активации: '+pending:'Подключены к Workspace';result.details=['Установок Lampa: '+list.length,'Недавно в сети: '+list.filter(x=>Date.now()/1000-x.last<35).length,'Профилей ждут применения: '+list.filter(x=>x.applied<x.revision).length];}
    if(entry.error){result.state="error";result.label="Данные устарели";result.details.push(entry.error);}
    return result;
  }
  function paint(){
    if(!current)return;const state=current;
    const open=state.tickets.filter(t=>t.status==='open').length,unread=state.tickets.filter(t=>t.unread_count>0).length;
    const cards=[['health','Workspace и realtime','settings']];
    if(state.permissions.canManageSettings)cards.push(['frp','FRP · удалённый доступ','frp'],['voice','Аудиобот','voice'],['lampac','Lampac','lampac'],['torrents','TorrServer','lampac'],['devices','Устройства Lampa','lampac']);
    const h=cache.health?.data,tg=h?.telegram,m=h?.maintenance;
    const special=[];
    if(tg){const backlog=['pendingIncomingMessages','pendingMessages','pendingCustomerReplies'].reduce((n,k)=>n+number(tg.delivery?.[k]),0),ok=tg.configured&&tg.enabled&&tg.connected&&(tg.mode!=='private'||tg.polling?.owner);special.push({at:cache.health.at,title:'Telegram поддержки',target:'chat',state:ok&&!backlog?'ok':'warning',label:!tg.configured?'Не настроен':!tg.enabled?'Выключен':ok?'На связи':'Нет связи',details:['Очередь доставки: '+backlog,'Ошибки медиа: '+number(tg.delivery?.mediaFailures),'Конфликты polling: '+number(tg.polling?.conflicts)]});}
    if(m){special.push({at:cache.health.at,title:'Диск и резервные копии',target:'settings',state:m.healthy?'ok':'warning',label:m.healthy?'В норме':'Требует внимания',details:['Диск занят: '+(m.disk?.usedPercent??'—')+'%','Свободно: '+bytes(m.disk?.freeBytes),'Последняя копия: '+(m.lastBackupAt?new Date(m.lastBackupAt).toLocaleString('ru-RU'):'нет данных'),m.backupInProgress?'Создаётся резервная копия':m.backupOverdue?'Резервная копия просрочена':m.lastBackupError].filter(Boolean)});}
    if(!tg)special.push({...cardData('health'),state:'unknown',label:'Нет данных',title:'Telegram поддержки',target:'chat',details:[cache.health?.error||'Ожидаем состояние бота']});
    if(!m)special.push({...cardData('health'),state:'unknown',label:'Нет данных',title:'Диск и резервные копии',target:'settings',details:[cache.health?.error||'Ожидаем состояние обслуживания']});
    if(cache.health?.error)special.forEach(c=>{c.state='error';c.label=h?'Данные устарели':'Нет данных';});
    const items=cards.map(([key,title,target])=>({...cardData(key),title,target})).concat(special),issues=items.filter(c=>['warning','error'].includes(c.state));
    const root=document.getElementById('home'), signature=String(state.permissions.canManageSettings);
    if(mounted!==signature){
      root.innerHTML=`<div class="section shell-home"><div class="page-heading overview-heading"><div><span class="eyebrow">Рабочее пространство</span><h2>Обзор сервисов</h2><p>Обращения, соединения и состояние сервера в одном месте.</p></div><button class="ghost" data-overview-refresh>Обновить</button></div><p id="overview-freshness" class="overview-freshness" role="status"></p><div class="overview-stats"><div><span>Открытые обращения</span><strong id="overview-open">—</strong></div><div><span>Требуют прочтения</span><strong id="overview-unread">—</strong></div><div><span>Требуют внимания</span><strong id="overview-issues">—</strong></div></div><details class="overview-alert"><summary id="overview-alert-title">Состояние сервисов</summary><p id="overview-alert-detail"></p></details><div class="service-grid">${items.map((c,i)=>`<article class="service-card"><div class="service-heading"><h3>${esc(c.title)}</h3><span id="overview-status-${i}" class="service-status"></span></div><ul id="overview-details-${i}"></ul><footer><small id="overview-time-${i}"></small><button class="ghost" data-module-target="${c.target}">Открыть ↗</button></footer></article>`).join('')}</div></div>`;
      mounted=signature;
    }
    const text=(id,value)=>{const el=document.getElementById(id);if(el.textContent!==String(value))el.textContent=value;};
    text('overview-open',open);text('overview-unread',unread);text('overview-issues',issues.length);
    text('overview-alert-title',issues.length?`Требуют внимания: ${issues.length}`:'Нет предупреждений от сервисов');
    text('overview-alert-detail',issues.length?issues.map(c=>c.title+': '+c.label).join(' · '):'Состояние уточняется при каждой проверке. Выключенные сервисы отмечены отдельно.');
    const last=Math.max(0,...Object.values(cache).map(c=>c.checkedAt||c.at||0));
    text('overview-freshness',busy?'Проверяем сервисы…':document.hidden?'Автообновление при возвращении на вкладку':`Автообновление · каждые 15 секунд${last?' · Проверено '+new Date(last).toLocaleTimeString('ru-RU'):''}`);
    const refreshButton=root.querySelector('[data-overview-refresh]');refreshButton.setAttribute('aria-busy',String(busy));
    items.forEach((c,i)=>{const status=document.getElementById('overview-status-'+i);status.className='service-status '+c.state;text(status.id,c.label);const details=document.getElementById('overview-details-'+i),html=c.details.map(d=>`<li>${esc(d)}</li>`).join('')||'<li>Ожидаем ответ сервиса…</li>';if(details.innerHTML!==html)details.innerHTML=html;text('overview-time-'+i,c.at?'Данные: '+new Date(c.at).toLocaleTimeString('ru-RU'):'Ещё не обновлялись');});
  }
  function stop(){generation++;controller?.abort();controller=null;busy=false;clearInterval(timer);timer=null;}
  async function refresh(){
    if(busy||!current?.token||current.view!=='home'||document.hidden)return;
    busy=true;controller=new AbortController();const g=generation,token=current.token,keys=current.permissions.canManageSettings?Object.keys(sources):['health'];paint();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]);
    const results=await Promise.allSettled(keys.map(async key=>{const r=await fetch(sources[key],{headers:{'x-admin-token':token},signal,cache:'no-store'});if(!r.ok)throw Error(r.status===403?'Нет доступа':r.status===503?'Сервис не настроен':'Сервис не отвечает ('+r.status+')');return r.json();}));
    if(g!==generation)return;
    results.forEach((r,i)=>{const key=keys[i];cache[key]=r.status==='fulfilled'?{data:r.value,at:Date.now(),checkedAt:Date.now()}:{...cache[key],error:r.reason?.name==='TimeoutError'?'Истекло время ожидания':r.reason?.message||'Нет связи',checkedAt:Date.now()};});busy=false;controller=null;paint();
  }
  function reset(){stop();cache={};identity='';mounted='';current=null;document.getElementById('home').innerHTML='';}
  function render(state){
    const next=String(state.token||'')+':'+!!state.permissions.canManageSettings;if(next!==identity){reset();identity=next;}
    current=state;
    const allowed=modules.filter(m=>!m.manager||state.permissions.canManageSettings);
    document.querySelectorAll('.navbtn').forEach(b=>{b.hidden=!allowed.some(m=>m.id===b.dataset.view);if(b.dataset.view===state.view&&window.matchMedia?.('(max-width:560px)').matches)b.scrollIntoView({block:'nearest',inline:'nearest'});});
    if(state.view==='home'&&state.token){paint();if(!timer){refresh();timer=setInterval(refresh,15000);}}
    else stop();
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stop();if(current?.view==='home')paint();}else if(current)render(current);});
  window.addEventListener('online',()=>refresh());
  window.addEventListener('focus',()=>refresh());
  document.getElementById('home').addEventListener('click',e=>{if(e.target.closest('[data-overview-refresh]'))refresh();});
  document.getElementById('home').addEventListener('click', e => { const target = e.target.closest('[data-module-target]'); if (target) setView(target.dataset.moduleTarget); });
  return { modules, render, reset };
})();
