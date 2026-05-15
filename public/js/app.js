'use strict';
const ECATS=[
  {i:'😀',e:['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😊','😇','🥰','😍','🤩','😘','😗','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','💩','🤡']},
  {i:'👋',e:['👋','🤚','🖐','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💅','💪','🦾','👀','👁','👅','👄','🫦']},
  {i:'🐶',e:['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🐙','🦑','🦐','🦞','🦀','🐟','🐠','🐬','🐳','🐋','🦈','🦭','🐊','🐅','🐆','🦓','🐘','🦛','🦏','🐪','🦒','🦘','🐃','🐄','🐎','🐖','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🕊','🐇','🦝','🦔']},
  {i:'🍎',e:['🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🧀','🥚','🍳','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🌮','🌯','🥗','🥘','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','☕','🍵','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧃','🥤','🧋']},
  {i:'⚽',e:['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','⛳','🏹','🎣','🥊','🥋','🛹','⛸','🏂','🏋️','🤼','🤸','🏊','🚴','🏆','🥇','🥈','🥉','🏅','🎖','🎪','🎭','🩰','🎨','🎬','🎤','🎧','🎸','🥁','🎲','♟','🎯','🎳','🎮','🎰','🧩']},
  {i:'✈️',e:['🚗','🚕','🚙','🚌','🏎','🚓','🚑','🚒','🚚','🚜','🏍','✈️','🚀','🛸','🚁','⛵','🚤','🛥','🚢','💺','🚂','🚆','🚇','🚉','🌍','🗺','🏔','🌋','🏕','🏖','🏜','🏝','🏞','🏛','🏗','🏠','🏡','🏢','🏥','🏦','🏨','🏪','🏫','🏬','🏭','🏯','🏰','💒','🗼','🗽','🎌']},
  {i:'❤️',e:['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','✨','⭐','🌟','💫','🔥','💥','🎉','🎊','🎁','🎈','🌈','☀️','🌤','⛅','🌧','❄️','☃️','⛄','🌊','🌸','🌺','🌻','🌹','🍀','🌿','🍃','🎵','🎶','💤','💬','💭','🔔','💡','🔍','💎','🔑','🧲','🌙','💸','💯']}
];

const S={token:null,tid:null,uname:null,closed:false,file:null,uploading:false,lastDate:null,epOpen:false,unread:0,lastTyping:0,hasMore:false,oldestTs:null,_msgs:[]};
const CFG={workStartHour:8,workEndHour:23,offhoursEnabled:true,offhoursBannerText:'',offhoursRejectText:'',timezone:'Europe/Moscow',online:true};
const $=id=>document.getElementById(id);
const ni=$('ni'),sb=$('sb'),sl=$('sl');
const mwrap=$('mwrap'),ml=$('ml');
const ti=$('ti'),sndbtn=$('sndbtn');
const abt=$('abt'),fi=$('fi');
const fp=$('fp'),fpth=$('fpth'),fprm=$('fprm');
const ia=$('ia'),cbar=$('cbar'),hcl=$('hcl');
const ebt=$('ebt'),ep=$('ep');
const tst=$('tst'),sdwn=$('sdwn');
const newbtn=$('newbtn');

/* ── SOCKET ── */
const socket=io({autoConnect:false});
socket.on('message',msg=>{
  const b=isBot();
  S._msgs.push(msg);
  renderMsg(msg);
  saveMsgCache();
  if(b)scrollBot();
  else{S.unread++;updSDB()}
  if(msg.sender==='support'){playNotifSound();showBrowserNotif(msg);}
});
socket.on('ticket_closed',({by})=>{markClosed();showToast(by==='support'?'Обращение закрыто оператором':by==='inactivity'?'Обращение закрыто по неактивности':'Обращение закрыто','info')});
socket.on('ticket_reopened',()=>{S.closed=false;ia.style.display='';cbar.classList.remove('on');hcl.style.display='';saveMsgCache();showToast('Обращение переоткрыто','ok')});
socket.on('ticket_orphaned',()=>{markClosedNoReopen();showToast('Тема удалена — начните новый чат','err',5000);});
socket.on('messages_read',()=>{/* support has opened the ticket */});
socket.on('typing_support',()=>{showSupportTyping();});
socket.on('error',({message})=>{if(message==='Unauthorized'){clearS();clearMsgCache();showLogin();showToast('Сессия истекла — войдите снова','err');}});
let _socketEverConnected=false;
socket.on('connect',()=>{
  setConnStatus('on');
  if(S.tid){
    socket.emit('join_ticket',{ticketId:S.tid,sessionToken:S.token});
    // Only refresh on reconnect — initial load already fetched fresh data.
    if(_socketEverConnected)refreshMessages();
    if(Notification.permission==='granted')setTimeout(setupPushSubscription,800);
  }
  _socketEverConnected=true;
});
socket.on('disconnect',()=>setConnStatus('off'));
socket.io.on('reconnect_attempt',()=>setConnStatus('connecting'));

/* ── SESSION ── */
const SK='sc_v3';
const saveS=()=>localStorage.setItem(SK,JSON.stringify({t:S.token,id:S.tid,n:S.uname}));
const loadS=()=>{try{return JSON.parse(localStorage.getItem(SK))}catch{return null}};
const clearS=()=>localStorage.removeItem(SK);

/* ── DRAFT ── */
const DRAFT_KEY='sc_draft';
const saveDraft=()=>ti.value?localStorage.setItem(DRAFT_KEY,ti.value):localStorage.removeItem(DRAFT_KEY);
const loadDraft=()=>{const d=localStorage.getItem(DRAFT_KEY);if(d){ti.value=d;resize();updSend();}};
const clearDraft=()=>localStorage.removeItem(DRAFT_KEY);

/* ── MESSAGE CACHE (instant paint on reload) ── */
const MCACHE_KEY='sc_msgs_v1';
const MCACHE_LIMIT=80;
function saveMsgCache(){
  if(!S.tid||!S._msgs.length)return;
  try{
    const slice=S._msgs.slice(-MCACHE_LIMIT);
    localStorage.setItem(MCACHE_KEY,JSON.stringify({tid:S.tid,msgs:slice,closed:S.closed}));
  }catch{}
}
function loadMsgCache(tid){
  try{
    const raw=localStorage.getItem(MCACHE_KEY);if(!raw)return null;
    const c=JSON.parse(raw);
    return c&&c.tid===tid?c:null;
  }catch{return null}
}
function clearMsgCache(){localStorage.removeItem(MCACHE_KEY);}

/* ── INIT ── */
async function init(){
  await refreshConfig();
  buildEmoji();
  updateLoginHint();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('[SW] register failed',e));
  }

  setAppHeight();
  window.addEventListener('resize',setAppHeight);

  // Refresh messages when tab becomes visible again
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'&&S.tid)refreshMessages();
    if(document.visibilityState==='visible'&&socket.connected)setConnStatus('on');
  });

  // Bell button → request notification permission
  $('nbtn')?.addEventListener('click',requestNotifications);

  // Update working-hours status every minute
  setInterval(()=>{
    updateLoginHint();
    if(socket.connected)setConnStatus('on');
  },60000);

  const sv=loadS();
  if(sv){
    // 1) Optimistic paint from local cache — chat appears instantly
    const cached=loadMsgCache(sv.id);
    if(cached){
      S.token=sv.t;S.tid=sv.id;S.uname=sv.n;
      showChat();renderMsgs(cached.msgs);scrollBot(false);loadDraft();
      if(cached.closed){S.closed=true;markClosed();}
    }
    // 2) Hit the network in background, reconcile when it lands
    try{
      const r=await fetch('/api/session/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:sv.t})});
      if(r.ok){
        const data=await r.json();
        if(data.orphaned){clearS();clearMsgCache();showLogin();showToast('Тема удалена — начните новый чат','err');return;}
        const{ticket,messages}=data;
        S.token=sv.t;S.tid=ticket.id;S.uname=ticket.user_name;
        S.hasMore=data.hasMore||false;
        if(!cached)showChat();
        renderMsgs(messages);scrollBot(false);socket.connect();
        if(S.hasMore)showLoadOlder();
        if(!cached)loadDraft();
        if(ticket.status==='closed'){
          S.closed=true;
          if(ticket.telegram_topic_deleted){markClosedNoReopen();}
          else{markClosed();}
        }else if(cached&&cached.closed){
          // Server says open — undo cached closed state
          S.closed=false;ia.style.display='';cbar.classList.remove('on');hcl.style.display='';
        }
        saveMsgCache();
        return;
      }
      clearS();clearMsgCache();
      if(cached){showLogin();return;}
    }catch{
      // Network failure — keep cached chat on screen and the saved session for next load
      if(cached){socket.connect();return;}
      showLogin();return;
    }
  }
  showLogin();
}

function setAppHeight(){
  // 100dvh не всегда поддерживается, ставим через JS как запасной вариант
  const h=window.innerHeight;
  document.getElementById('app').style.setProperty('height',h+'px');
}

/* ── LOGIN ── */
ni.addEventListener('input',()=>{sb.disabled=!ni.value.trim()});
ni.addEventListener('keydown',e=>{if(e.key==='Enter')sb.click()});
sb.addEventListener('click',async()=>{
  const name=ni.value.trim();if(!name)return;
  sb.disabled=true;sl.textContent='Подключаем...';
  try{
    const r=await fetch('/api/session/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
    if(!r.ok)throw 0;
    const{sessionToken,ticketId,userName}=await r.json();
    S.token=sessionToken;S.tid=ticketId;S.uname=userName;S.hasMore=false;
    saveS();showChat();renderMsgs([]);socket.connect();loadDraft();
  }catch{showToast('Ошибка подключения','err');sb.disabled=false;sl.textContent='Начать чат'}
});

function showLogin(){$('ls').classList.add('on');$('cs').classList.remove('on');setTimeout(()=>ni.focus(),150)}
function showChat(){$('ls').classList.remove('on');$('cs').classList.add('on');tryRequestNotifications();setConnStatus('connecting');}

/* ── CLOSE ── */
hcl.addEventListener('click',()=>{
  if(S.closed)return;
  dlg('Закрыть обращение?','После закрытия можно начать новый чат.',async()=>{
    try{
      const r=await fetch(`/api/tickets/${S.tid}/close`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:S.token})});
      if(!r.ok)throw 0;
      markClosed();
    }catch{showToast('Ошибка — попробуйте снова','err');}
  });
});
function markClosed(){S.closed=true;ia.style.display='none';cbar.classList.add('on');hcl.style.display='none';saveMsgCache();}
const markClosedNoReopen=markClosed;


/* ── NEW CHAT ── */
newbtn.addEventListener('click',()=>{
  clearS();clearMsgCache();
  socket.disconnect();
  S.token=null;S.tid=null;S.uname=null;S.closed=false;S.lastDate=null;S.unread=0;S.lastTyping=0;S.hasMore=false;S.oldestTs=null;S._msgs=[];
  ml.innerHTML='';
  cbar.classList.remove('on');ia.style.display='';hcl.style.display='';
  ni.value='';sb.disabled=true;sl.textContent='Начать чат';
  showLogin();updateLoginHint();
});

/* ── LOAD OLDER ── */
function showLoadOlder(){
  if(ml.querySelector('.lo-btn'))return;
  const btn=document.createElement('button');btn.className='lo-btn';btn.textContent='⬆ Загрузить ранее';
  btn.addEventListener('click',loadOlderMessages);
  ml.prepend(btn);
}
function hideLoadOlder(){ml.querySelector('.lo-btn')?.remove();}
async function loadOlderMessages(){
  if(!S.tid||!S.token||!S.hasMore)return;
  const btn=ml.querySelector('.lo-btn');
  if(btn){btn.disabled=true;btn.textContent='Загружаем...';}
  try{
    const r=await fetch(`/api/tickets/${S.tid}/messages/older`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:S.token,before:S.oldestTs})});
    if(!r.ok)throw 0;
    const{messages,hasMore}=await r.json();
    if(!messages.length){S.hasMore=false;hideLoadOlder();return;}
    S.hasMore=hasMore;
    S.oldestTs=messages[0].created_at;
    S._msgs=[...messages,...S._msgs];
    _pinToBottom=false; // user is reading history, don't snap back
    // Re-render all preserving distance from bottom
    const fromBot=mwrap.scrollHeight-mwrap.scrollTop-mwrap.clientHeight;
    _doRender();
    if(S.hasMore)showLoadOlder();
    requestAnimationFrame(()=>{mwrap.scrollTop=mwrap.scrollHeight-mwrap.clientHeight-fromBot;});
  }catch{if(btn){btn.disabled=false;btn.textContent='⬆ Загрузить ранее';}}
}

/* ── RENDER ── */
function _doRender(){
  ml.innerHTML='';S.lastDate=null;
  if(!S._msgs.length){renderEmpty();return;}
  S._msgs.forEach(m=>renderMsg(m));
}
function renderMsgs(msgs){
  S._msgs=msgs.slice();S.oldestTs=msgs[0]?.created_at||null;
  _doRender();
}
function renderEmpty(){const d=document.createElement('div');d.className='emp';d.innerHTML=`<svg width="58" height="58" viewBox="0 0 58 58" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M29 6C16.3 6 6 15.3 6 27c0 6.3 2.9 12 7.6 16L12 52l9.5-2.8A23.5 23.5 0 0029 52c12.7 0 23-9.3 23-21S41.7 6 29 6Z"/><circle cx="20" cy="28" r="2" fill="currentColor" stroke="none"/><circle cx="29" cy="28" r="2" fill="currentColor" stroke="none"/><circle cx="38" cy="28" r="2" fill="currentColor" stroke="none"/></svg><p>Напишите ваш первый вопрос — ответим быстро</p>`;ml.appendChild(d)}
function renderSys(txt){ml.querySelector('.emp')?.remove();const d=document.createElement('div');d.className='sysmsg';d.innerHTML=`<span>${esc(txt)}</span>`;ml.appendChild(d)}

function renderMsg(msg){
  ml.querySelector('.emp')?.remove();
  if(msg.sender==='system'){renderSys(msg.content||'');return;}
  const dt=new Date(msg.created_at),ds=fmtDate(dt);
  if(ds!==S.lastDate){S.lastDate=ds;const s=document.createElement('div');s.className='dsp';s.innerHTML=`<span>${ds}</span>`;ml.appendChild(s)}
  const isO=msg.sender==='user';
  const w=document.createElement('div');w.className='msg '+(isO?'o':'i');
  if(msg.id)w.dataset.msgId=msg.id;
  let h='';
  if(!isO)h+=`<div class="bsnm">${esc(msg.sender_name)}</div>`;
  h+='<div class="bub">';
  if(msg.reply_to_id){const qname=esc(msg.reply_to_sender_name||'');const qt=msg.reply_to_type&&msg.reply_to_type!=='text'?(msg.reply_to_file_name?`📎 ${esc(msg.reply_to_file_name)}`:'📎 Медиа'):esc((msg.reply_to_content||'').slice(0,80));h+=`<div class="qblock" data-reply-id="${esc(msg.reply_to_id)}"><div class="qname">${qname}</div><div class="qtxt">${qt}</div></div>`;}
  if(msg.message_type==='image'&&msg.file_url){
    h+=`<img class="mimg" src="${esc(msg.file_url)}" loading="lazy" onclick="openLb(this)">`;
    if(msg.content)h+=`<div class="btxt" style="margin-top:5px">${esc(msg.content)}</div>`;
  }else if(msg.message_type==='video'&&msg.file_url){
    h+=`<video class="mvid" src="${esc(msg.file_url)}" controls preload="metadata"></video>`;
    if(msg.content)h+=`<div class="btxt" style="margin-top:5px">${esc(msg.content)}</div>`;
  }else if(msg.message_type==='audio'&&msg.file_url){
    h+=`<audio class="maud" src="${esc(msg.file_url)}" controls></audio>`;
  }else if(msg.file_url){
    h+=`<a class="mfile" href="${esc(msg.file_url)}" download="${esc(msg.file_name||'file')}" target="_blank" rel="noopener noreferrer"><div class="fic">${dico()}</div><div><div class="fnm">${esc(msg.file_name||'Файл')}</div></div></a>`;
    if(msg.content)h+=`<div class="btxt" style="margin-top:4px">${esc(msg.content)}</div>`;
  }else{h+=`<div class="btxt">${linkify(esc(msg.content||''))}</div>`}
  const tick=isO?`<svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="rgba(122,178,220,.6)" stroke-width="1.8" stroke-linecap="round"><path d="M1 5.5l3.5 3.5L14 1"/><path d="M6 9L14 1" opacity=".5"/></svg>`:'';
  h+=`<div class="bmeta">${tick}<span class="btime">${fmtTime(dt)}</span></div></div>`;
  w.innerHTML=h;ml.appendChild(w);
}

/* ── SEND ── */
async function send(){
  if(S.closed||S.uploading)return;
  if(CFG.offhoursEnabled&&!CFG.online){showToast(CFG.offhoursRejectText||'Сейчас нерабочее время. Напишите в рабочее время.','info');return;}
  const txt=ti.value.trim(),file=S.file;
  if(!txt&&!file)return;
  sndbtn.disabled=true;
  let fu=null,fn=null,fm=null,mt='text';
  if(file){
    S.uploading=true;showSpin(true);
    try{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/upload',{method:'POST',body:fd});if(!r.ok)throw 0;const d=await r.json();fu=d.url;fn=d.name;fm=d.mime;mt=d.type}
    catch{showToast('Ошибка загрузки','err');S.uploading=false;showSpin(false);sndbtn.disabled=false;return}
    S.uploading=false;showSpin(false);clearFile();
  }
  ti.value='';resize();updSend();closeEp();clearDraft();
  if(!socket.connected){showToast('Нет соединения — попробуйте позже','err');sndbtn.disabled=false;updSend();return;}
  socket.emit('send_message',{ticketId:S.tid,sessionToken:S.token,content:txt||null,fileUrl:fu,fileName:fn,fileMime:fm,messageType:mt},ack=>{
    if(ack?.error){
      if(ack.error==='Rate limit')showToast(`Слишком много сообщений — подождите ${ack.retryAfter||60}с`,'err');
      else if(ack.error==='Ticket is closed')showToast('Обращение закрыто','info');
      else showToast('Ошибка отправки','err');
    }
    sndbtn.disabled=false;updSend();
  });
}
sndbtn.addEventListener('click',send);
ti.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
ti.addEventListener('input',()=>{
  resize();updSend();saveDraft();
  if(!S.tid||S.closed)return;
  const now=Date.now();
  if(now-S.lastTyping>4000){S.lastTyping=now;socket.emit('typing',{ticketId:S.tid,sessionToken:S.token});}
});
const updSend=()=>{sndbtn.disabled=!ti.value.trim()&&!S.file};
function resize(){ti.style.height='auto';ti.style.height=Math.min(ti.scrollHeight,108)+'px'}

/* ── FILES ── */
abt.addEventListener('click',()=>{closeEp();fi.click()});
fi.addEventListener('change',()=>{if(fi.files[0]){setFile(fi.files[0]);fi.value=''}});
mwrap.addEventListener('dragover',e=>{e.preventDefault();mwrap.style.outline='2px dashed #2ca5e0';mwrap.style.outlineOffset='-8px'});
mwrap.addEventListener('dragleave',()=>{mwrap.style.outline=''});
mwrap.addEventListener('drop',e=>{e.preventDefault();mwrap.style.outline='';if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0])});
document.addEventListener('paste',e=>{if(S.closed)return;for(const it of(e.clipboardData?.items||[])){if(it.kind==='file'){setFile(it.getAsFile());break}}});
function setFile(f){
  if(f.size>50*1024*1024){showToast('Файл слишком большой (макс. 50 МБ)','err');return;}
  S.file=f;fp.style.display='block';fpth.innerHTML='';
  if(f.type.startsWith('image/')){const img=document.createElement('img');img.src=URL.createObjectURL(f);fpth.appendChild(img)}
  else{const d=document.createElement('div');d.className='fpnm';d.textContent=f.name;fpth.appendChild(d)}
  updSend();
}
function clearFile(){S.file=null;fp.style.display='none';fpth.innerHTML='';updSend()}
fprm.addEventListener('click',clearFile);
function showSpin(on){const ex=ia.querySelector('.uspin');if(on&&!ex){const d=document.createElement('div');d.className='uspin';d.innerHTML='<div class="sp"></div><span>Загрузка...</span>';ia.insertBefore(d,ia.firstChild)}else if(!on&&ex)ex.remove()}

/* ── EMOJI ── */
function buildEmoji(){
  const cats=document.createElement('div');cats.className='ecats';
  const grid=document.createElement('div');grid.className='egrid';
  ECATS.forEach((c,i)=>{
    const b=document.createElement('button');b.className='ecat'+(i===0?' on':'');b.textContent=c.i;
    b.onclick=()=>{cats.querySelectorAll('.ecat').forEach(x=>x.classList.remove('on'));b.classList.add('on');grid.innerHTML='';c.e.forEach(em=>{const btn=document.createElement('button');btn.className='eitm';btn.textContent=em;btn.onclick=()=>insE(em);grid.appendChild(btn)})};
    cats.appendChild(b);
  });
  ep.appendChild(cats);ep.appendChild(grid);
  ECATS[0].e.forEach(em=>{const btn=document.createElement('button');btn.className='eitm';btn.textContent=em;btn.onclick=()=>insE(em);grid.appendChild(btn)});
}
function insE(em){const s=ti.selectionStart,e2=ti.selectionEnd,v=ti.value;ti.value=v.slice(0,s)+em+v.slice(e2);ti.selectionStart=ti.selectionEnd=s+em.length;ti.focus();resize();updSend()}
ebt.addEventListener('click',()=>{if(ep.style.display==='none'){ep.style.display='block';S.epOpen=true;setTimeout(()=>mwrap.scrollTo({top:mwrap.scrollHeight}),50)}else closeEp()});
function closeEp(){ep.style.display='none';S.epOpen=false}
// НЕ закрываем emoji при фокусе textarea на мобильном — пусть остаётся

/* ── QUOTE SCROLL ── */
ml.addEventListener('click',e=>{
  const qb=e.target.closest('.qblock[data-reply-id]');
  if(!qb)return;
  const target=ml.querySelector(`[data-msg-id="${qb.dataset.replyId}"]`);
  if(!target)return;
  target.scrollIntoView({behavior:'smooth',block:'center'});
  target.classList.add('hl');
  setTimeout(()=>target.classList.remove('hl'),1600);
});

/* ── SCROLL ── */
let _pinToBottom=true;   // true → auto-scroll whenever content grows
let _autoScrolling=false; // true while we're scrolling programmatically

const isBot=()=>mwrap.scrollHeight-mwrap.scrollTop-mwrap.clientHeight<120;

function scrollBot(smooth=true){
  _pinToBottom=true;
  _autoScrolling=true;
  requestAnimationFrame(()=>{
    mwrap.scrollTo({top:mwrap.scrollHeight,behavior:smooth?'smooth':'auto'});
    // Give the browser time to fire the scroll event before clearing the flag
    setTimeout(()=>{_autoScrolling=false;},120);
  });
  S.unread=0;updSDB();
}

// Re-pin whenever content height grows (images loading, new messages, etc.)
new ResizeObserver(()=>{
  if(_pinToBottom) mwrap.scrollTo({top:mwrap.scrollHeight,behavior:'auto'});
}).observe(ml);

function updSDB(){
  const show=!isBot()||S.unread>0;
  sdwn.classList.toggle('on',show);
  let badge=sdwn.querySelector('.ubadge');
  if(S.unread>0){
    const isNew=!badge;
    if(isNew){badge=document.createElement('div');badge.className='ubadge';sdwn.appendChild(badge);}
    badge.textContent=S.unread;
    if(isNew){
      sdwn.classList.remove('bounce');
      requestAnimationFrame(()=>requestAnimationFrame(()=>sdwn.classList.add('bounce')));
    }
  }else badge?.remove();
}
mwrap.addEventListener('scroll',()=>{
  // Only update pin flag from genuine user scrolls, not our own programmatic ones
  if(!_autoScrolling) _pinToBottom=isBot();
  updSDB();
},{passive:true});
sdwn.addEventListener('click',()=>{scrollBot();S.unread=0;updSDB()});

/* ── LIGHTBOX ── */
window.openLb=img=>{const lb=document.createElement('div');lb.className='lb';lb.innerHTML=`<img src="${img.src}">`;lb.onclick=()=>lb.remove();document.body.appendChild(lb)};

/* ── DIALOG ── */
function dlg(title,msg,cb){
  const ov=document.createElement('div');ov.className='mov';
  ov.innerHTML=`<div class="mbox"><h3>${esc(title)}</h3><p>${esc(msg)}</p><div class="mbtns"><button class="mbc">Отмена</button><button class="mbo">Закрыть</button></div></div>`;
  ov.querySelector('.mbc').onclick=()=>ov.remove();
  ov.querySelector('.mbo').onclick=()=>{ov.remove();cb()};
  ov.onclick=e=>{if(e.target===ov)ov.remove()};
  document.body.appendChild(ov);
}

/* ── TOAST ── */
const TICO={ok:'✓',err:'✗',info:'ℹ'};
let tt;
function showToast(m,type='info',d=3200){
  clearTimeout(tt);
  tst.innerHTML=`<span class="tst-ico">${TICO[type]||'ℹ'}</span><span>${esc(m)}</span>`;
  tst.dataset.type=type;
  tst.classList.remove('on');void tst.offsetWidth;
  tst.classList.add('on');
  tt=setTimeout(()=>tst.classList.remove('on'),d);
}

/* ── WORKING HOURS (08:00–23:00 МСК = UTC+3) ── */
function supportOnline(){
  const h=(new Date().getUTCHours()+3)%24;
  return h>=8&&h<23;
}
function supportOpenText(){
  const now=new Date();
  const mskMins=(now.getUTCHours()*60+now.getUTCMinutes()+180)%(24*60);
  const openMins=8*60,closeMins=23*60;
  let until;
  if(mskMins<openMins)until=openMins-mskMins;
  else until=24*60-mskMins+openMins;
  const hh=Math.floor(until/60),mm=until%60;
  return hh>0?`через ${hh} ч ${mm} мин`:`через ${mm} мин`;
}
function updateLoginHint(){
  const sub=$('ls')?.querySelector('.lsub');
  if(!sub)return;
  if(!CFG.offhoursEnabled||CFG.online)sub.textContent='Представьтесь — ответим как можно скорее';
  else sub.textContent=CFG.offhoursBannerText||`Сейчас не в сети · ответим в ${String(CFG.workStartHour).padStart(2,'0')}:00 МСК (${supportOpenText()})`;
}
async function refreshConfig(){
  try{
    const r=await fetch('/api/chat-config');
    if(!r.ok)return;
    const d=await r.json();
    Object.assign(CFG,d.settings||{});
    CFG.online=!!d.online;
  }catch{}
}

/* ── CONNECTION STATUS ── */
function setConnStatus(s){
  const dot=$('cs')?.querySelector('.hdot');
  const txt=$('cs')?.querySelector('.hstxt');
  if(!dot||!txt)return;
  let newTxt,dotBg,dotAnim='none';
  if(s==='on'){
    if(!CFG.offhoursEnabled||CFG.online){newTxt='онлайн';dotBg='var(--green)';dotAnim='blink 2.5s ease infinite';}
    else{newTxt=`ответим в ${String(CFG.workStartHour).padStart(2,'0')}:00 МСК`;dotBg='#6b7280';}
  }else if(s==='connecting'){newTxt='подключение...';dotBg='#f59e0b';}
  else{newTxt='нет соединения';dotBg='var(--red)';}
  dot.style.background=dotBg;dot.style.animation=dotAnim;
  if(txt.textContent!==newTxt){
    txt.classList.remove('anim');void txt.offsetWidth;
    txt.textContent=newTxt;txt.classList.add('anim');
  }
}

/* ── REFRESH MESSAGES ── */
async function refreshMessages(){
  if(!S.tid||!S.token)return;
  try{
    const r=await fetch('/api/session/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:S.token})});
    if(!r.ok)return;
    const data=await r.json();
    if(data.orphaned){clearS();clearMsgCache();showLogin();showToast('Сессия истекла — начните новый чат','err');return;}
    const{ticket,messages}=data;
    // Sync ticket status
    if(ticket.status==='closed'&&!S.closed)markClosed();
    else if(ticket.status==='open'&&S.closed){S.closed=false;ia.style.display='';cbar.classList.remove('on');hcl.style.display='';}
    // Append only messages not yet in S._msgs
    const knownIds=new Set(S._msgs.map(m=>m.id));
    const fresh=messages.filter(m=>m.id&&!knownIds.has(m.id));
    if(!fresh.length)return;
    const atBottom=isBot();
    S._msgs.push(...fresh);
    fresh.forEach(renderMsg);
    saveMsgCache();
    if(atBottom)scrollBot(false);
  }catch{}
}

/* ── SUPPORT TYPING ── */
let _typingHide=null;
function showSupportTyping(){
  if(S.closed)return;
  const bar=$('typing-bar');
  if(!bar)return;
  bar.style.display='';
  clearTimeout(_typingHide);
  _typingHide=setTimeout(()=>{bar.style.display='none';},3000);
}

/* ── NOTIFICATIONS ── */
let _audioCtx=null;
function _getAudioCtx(){
  if(!_audioCtx)_audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  if(_audioCtx.state==='suspended')_audioCtx.resume().catch(()=>{});
  return _audioCtx;
}
// Unlock AudioContext on first user interaction (required on mobile)
['click','touchstart'].forEach(ev=>document.addEventListener(ev,()=>_getAudioCtx(),{once:true,passive:true}));

function playNotifSound(){
  try{
    const ctx=_getAudioCtx();
    const osc=ctx.createOscillator();const gain=ctx.createGain();
    osc.connect(gain);gain.connect(ctx.destination);
    osc.frequency.value=880;osc.type='sine';
    gain.gain.setValueAtTime(0.12,ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.35);
    osc.start(ctx.currentTime);osc.stop(ctx.currentTime+0.35);
  }catch{}
}
async function requestNotifications(){
  if(!('Notification' in window)){showToast('Уведомления не поддерживаются браузером');return;}
  if(Notification.permission==='granted'){showToast('Уведомления уже включены ✓');await setupPushSubscription();return;}
  if(Notification.permission==='denied'){showToast('Уведомления заблокированы — разрешите в настройках браузера');return;}
  try{
    const p=await Notification.requestPermission();
    if(p==='granted'){showToast('Уведомления включены ✓');await setupPushSubscription();}
    else showToast('Уведомления не разрешены');
  }catch{showToast('Ошибка запроса уведомлений');}
}

async function setupPushSubscription(){
  if(!S.tid||!S.token)return;
  if(!('serviceWorker' in navigator)||!('PushManager' in window))return;
  try{
    const reg=await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(sub){
      // Already subscribed — re-send to server in case ticket changed
      await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticketId:S.tid,sessionToken:S.token,subscription:sub.toJSON()})});
      return;
    }
    const r=await fetch('/api/push/vapid-key');
    if(!r.ok)return;
    const{publicKey}=await r.json();
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKey});
    await fetch('/api/push/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticketId:S.tid,sessionToken:S.token,subscription:sub.toJSON()})});
  }catch(e){console.warn('[Push] subscribe error',e);}
}

function tryRequestNotifications(){} // kept for compat
function showBrowserNotif(msg){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  if(document.visibilityState==='visible')return;
  try{
    const n=new Notification('Поддержка KV9RU',{body:msg.content||'Новое сообщение',icon:'/logo.png',tag:'support-msg'});
    setTimeout(()=>n.close(),5000);
    n.onclick=()=>{window.focus();n.close()};
  }catch{}
}

/* ── UTILS ── */
const esc=s=>s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):'';
const linkify=t=>t.replace(/https?:\/\/[^\s<>"&]+/g,url=>`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
const fmtTime=d=>d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
function fmtDate(d){const n=new Date(),td=new Date(n.getFullYear(),n.getMonth(),n.getDate()),diff=Math.round((td-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/86400000);if(diff===0)return'Сегодня';if(diff===1)return'Вчера';return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'})}
function dico(){return`<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="1" width="14" height="16" rx="2"/><path d="M5 6h8M5 9h8M5 12h5"/></svg>`}

/* ── RIPPLE ── */
document.addEventListener('pointerdown',e=>{
  const btn=e.target.closest('.hbtn,.lbtn,.newbtn,.sndbtn,.icn,.mbo,.mbc');
  if(!btn)return;
  const r=document.createElement('span');r.className='rpl';
  const rect=btn.getBoundingClientRect();
  const size=Math.max(rect.width,rect.height)*2;
  r.style.cssText=`width:${size}px;height:${size}px;left:${e.clientX-rect.left-size/2}px;top:${e.clientY-rect.top-size/2}px`;
  btn.appendChild(r);
  setTimeout(()=>r.remove(),600);
});

/* prevent double-tap zoom */
let lt=0;document.addEventListener('touchend',e=>{const n=Date.now();if(n-lt<300&&e.target.tagName!=='TEXTAREA'&&e.target.tagName!=='INPUT')e.preventDefault();lt=n},{passive:false});

init();
