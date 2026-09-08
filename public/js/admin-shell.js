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
  let current, cache={}, timer=null, busy=false, generation=0, identity='';
  const sources={health:'/api/admin/health',frp:'/api/admin/frp',voice:'/api/admin/voice',lampac:'/api/admin/lampac',torrents:'/api/admin/lampac/torrents',devices:'/api/admin/lampac/devices'};
  const number=n=>Number.isFinite(Number(n))?Number(n):0;
  const bytes=n=>Number.isFinite(Number(n))?(Number(n)/1073741824).toLocaleString('ru-RU',{maximumFractionDigits:1})+' ГиБ':'—';
  function cardData(key) {
    const entry=cache[key];
    if(!entry)return {state:'unknown',label:'Проверяется',details:[]};
    if(entry.error)return {state:'error',label:'Нет данных',details:[entry.error],at:entry.at};
    const d=entry.data, result={state:'ok',label:'Работает',details:[],at:entry.at};
    if(key==='health')result.details=['Версия '+(d.version||'—'),'Без перезапуска: '+Math.floor(number(d.uptime)/3600)+' ч '+Math.floor(number(d.uptime)%3600/60)+' мин','Realtime: '+number(d.realtime?.connectedClients)+' подключений'];
    if(key==='frp'){result.state=d.monitoringError||d.error?'error':d.running?'ok':'warning';result.label=d.monitoringError?'Мониторинг недоступен':d.running?'Запущен':'Остановлен';result.details=['Клиенты в сети: '+(d.monitoringError?'—':(d.clients||[]).filter(x=>x.online).length),'Туннели: '+(d.devices||[]).length,'Версия '+(d.version||'—'),d.monitoringError||d.error].filter(Boolean);}
    if(key==='voice'){const jobs=d.jobs||[];result.state=d.error?'error':d.config?.enabled?'ok':'warning';result.label=d.error?'Ошибка':d.config?.enabled?(d.busy?'Обрабатывает':'Ожидает задания'):'Выключен';result.details=['Сегодня: '+Math.ceil(number(d.todaySeconds)/60)+' / '+number(d.config?.dailyMinutes)+' мин','В последних 30 заданиях: '+jobs.filter(j=>['pending','ready','sending','cleanup'].includes(j.status)).length+' незавершённых, '+jobs.filter(j=>['failed','uncertain'].includes(j.status)).length+' с ошибками','VPN: '+(d.config?.vpnEnabled?(d.vpn?.running?'запущен':'не запущен'):'выключен'),d.error].filter(Boolean);}
    if(key==='lampac'){result.state=d.healthy?'ok':'error';result.label=d.healthy?'Доступен':d.service?.ActiveState==='active'?'HTTP недоступен':'Остановлен';result.details=['Версия '+(d.version||'—'),'Память: '+bytes(d.service?.MemoryCurrent),'Автозапуск: '+(d.service?.UnitFileState==='enabled'?'да':'нет')];}
    if(key==='torrents'){const list=d.torrents||[];result.details=['Торрентов: '+list.length,'Работают: '+list.filter(t=>t.stat===3).length,'Буфер: '+bytes(list.reduce((n,t)=>n+number(t.loaded_size),0)),'Загрузка: '+(list.reduce((n,t)=>n+number(t.download_speed),0)/1048576).toFixed(1)+' МиБ/с'];}
    if(key==='devices'){const list=d.devices||[],pending=list.filter(x=>x.enabled===0).length;result.state=pending?'warning':'ok';result.label=pending?'Ожидают активации: '+pending:'Подключены к Workspace';result.details=['Установок Lampa: '+list.length,'Недавно в сети: '+list.filter(x=>Date.now()/1000-x.last<35).length,'Профилей ждут применения: '+list.filter(x=>x.applied<x.revision).length];}
    return result;
  }
  function paint(){
    if(!current)return;const state=current,allowed=modules.filter(m=>!m.manager||state.permissions.canManageSettings);
    const open=state.tickets.filter(t=>t.status==='open').length,unread=state.tickets.filter(t=>t.unread_count>0).length;
    const cards=[['health','Workspace и realtime','settings']];
    if(state.permissions.canManageSettings)cards.push(['frp','FRP · удалённый доступ','frp'],['voice','Аудиобот','voice'],['lampac','Lampac','lampac'],['torrents','TorrServer','lampac'],['devices','Устройства Lampa','lampac']);
    const h=cache.health?.error?null:cache.health?.data,tg=h?.telegram,m=h?.maintenance;
    const special=[];
    if(tg){const backlog=['pendingIncomingMessages','pendingMessages','pendingCustomerReplies'].reduce((n,k)=>n+number(tg.delivery?.[k]),0),ok=tg.configured&&tg.enabled&&tg.connected&&(tg.mode!=='private'||tg.polling?.owner);special.push({at:cache.health.at,title:'Telegram поддержки',target:'chat',state:ok&&!backlog?'ok':'warning',label:!tg.configured?'Не настроен':!tg.enabled?'Выключен':ok?'На связи':'Нет связи',details:['Очередь доставки: '+backlog,'Ошибки медиа: '+number(tg.delivery?.mediaFailures),'Конфликты polling: '+number(tg.polling?.conflicts)]});}
    if(m){special.push({at:cache.health.at,title:'Диск и резервные копии',target:'settings',state:m.healthy?'ok':'warning',label:m.healthy?'В норме':'Требует внимания',details:['Диск занят: '+(m.disk?.usedPercent??'—')+'%','Свободно: '+bytes(m.disk?.freeBytes),'Последняя копия: '+(m.lastBackupAt?new Date(m.lastBackupAt).toLocaleString('ru-RU'):'нет данных'),m.backupInProgress?'Создаётся резервная копия':m.backupOverdue?'Резервная копия просрочена':m.lastBackupError].filter(Boolean)});}
    if(!tg)special.push({...cardData('health'),state:'unknown',label:'Нет данных',title:'Telegram поддержки',target:'chat',details:[cache.health?.error||'Ожидаем состояние бота']});
    if(!m)special.push({...cardData('health'),state:'unknown',label:'Нет данных',title:'Диск и резервные копии',target:'settings',details:[cache.health?.error||'Ожидаем состояние обслуживания']});
    const items=cards.map(([key,title,target])=>({...cardData(key),title,target})).concat(special),issues=items.filter(c=>['warning','error'].includes(c.state));
    document.getElementById('home').innerHTML=`<div class="section shell-home"><div class="page-heading overview-heading"><div><span class="eyebrow">Рабочее пространство</span><h2>Центр управления</h2><p>Сервисы, нагрузка и события · автообновление каждые 15 секунд</p></div><button class="ghost" data-overview-refresh ${busy?'disabled':''}>${busy?'Проверяем…':'Обновить'}</button></div><div class="overview-stats"><div><span>Открытые обращения</span><strong>${open}</strong></div><div><span>Требуют прочтения</span><strong>${unread}</strong></div><div><span>Требуют внимания</span><strong>${issues.length}</strong></div></div>${issues.length?`<div class="overview-alert" role="status">${issues.map(x=>esc(x.title+': '+x.label)).join(' · ')}</div>`:''}<div class="service-grid">${items.map(c=>`<article class="service-card"><div class="service-heading"><h3>${esc(c.title)}</h3><span class="service-status ${c.state}">${esc(c.label)}</span></div><ul>${c.details.map(d=>`<li>${esc(d)}</li>`).join('')}</ul><footer><small>${c.at?'Проверка: '+new Date(c.at).toLocaleTimeString('ru-RU'):'Последняя проверка недоступна'}</small><button class="ghost" data-module-target="${c.target}">Открыть ↗</button></footer></article>`).join('')}</div><h3>Быстрый доступ</h3><div class="overview-links">${allowed.filter(m=>m.id!=='home').map(m=>`<button class="ghost" data-module-target="${m.id}">${m.label}</button>`).join('')}</div></div>`;
  }
  async function refresh(){
    if(busy||!current?.token||current.view!=='home'||document.hidden)return;
    busy=true;const g=generation,token=current.token,keys=current.permissions.canManageSettings?Object.keys(sources):['health'];paint();
    const results=await Promise.allSettled(keys.map(async key=>{const r=await fetch(sources[key],{headers:{'x-admin-token':token},signal:AbortSignal.timeout(8000),cache:'no-store'});if(!r.ok)throw Error(r.status===403?'Нет доступа':r.status===503?'Сервис не настроен':'Сервис не отвечает ('+r.status+')');return r.json();}));
    if(g!==generation)return;
    results.forEach((r,i)=>{cache[keys[i]]=r.status==='fulfilled'?{data:r.value,at:Date.now()}:{error:r.reason?.name==='TimeoutError'?'Истекло время ожидания':r.reason?.message||'Нет связи',at:Date.now()};});busy=false;paint();
  }
  function reset(){generation++;cache={};busy=false;identity='';clearInterval(timer);timer=null;}
  function render(state){
    const next=String(state.token||'')+':'+!!state.permissions.canManageSettings;if(next!==identity){reset();identity=next;}
    current=state;
    const allowed=modules.filter(m=>!m.manager||state.permissions.canManageSettings);
    document.querySelectorAll('.navbtn').forEach(b=>{b.hidden=!allowed.some(m=>m.id===b.dataset.view);});
    paint();
    if(state.view==='home'&&state.token){if(!timer){refresh();timer=setInterval(refresh,15000);}}
    else{clearInterval(timer);timer=null;}
  }
  document.getElementById('home').addEventListener('click',e=>{if(e.target.closest('[data-overview-refresh]'))refresh();});
  document.getElementById('home').addEventListener('click', e => { const target = e.target.closest('[data-module-target]'); if (target) setView(target.dataset.moduleTarget); });
  return { modules, render, reset };
})();
