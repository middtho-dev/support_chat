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

const S={token:null,tid:null,uname:null,closed:false,file:null,uploading:false,lastDate:null,epOpen:false,unread:0};
const $=id=>document.getElementById(id);
const ni=$('ni'),sb=$('sb'),sl=$('sl');
const mwrap=$('mwrap'),ml=$('ml');
const ti=$('ti'),sndbtn=$('sndbtn');
const abt=$('abt'),fi=$('fi');
const fp=$('fp'),fpth=$('fpth'),fprm=$('fprm');
const ia=$('ia'),cbar=$('cbar'),hcl=$('hcl');
const ebt=$('ebt'),ep=$('ep');
const tst=$('tst'),sdwn=$('sdwn');
const reopenbtn=$('reopenbtn'),newbtn=$('newbtn');

/* ── SOCKET ── */
const socket=io({autoConnect:false});
socket.on('message',msg=>{const b=isBot();renderMsg(msg);if(b)scrollBot();else{S.unread++;updSDB()}});
socket.on('ticket_closed',({by})=>{markClosed();showToast(by==='support'?'Обращение закрыто оператором':by==='inactivity'?'Обращение закрыто по неактивности':'Обращение закрыто')});
socket.on('ticket_reopened',()=>{S.closed=false;ia.style.display='';cbar.style.display='none';hcl.style.display='';showToast('Обращение переоткрыто')});
socket.on('connect',()=>{if(S.tid)socket.emit('join_ticket',{ticketId:S.tid,sessionToken:S.token})});

/* ── SESSION ── */
const SK='sc_v3';
const saveS=()=>localStorage.setItem(SK,JSON.stringify({t:S.token,id:S.tid,n:S.uname}));
const loadS=()=>{try{return JSON.parse(localStorage.getItem(SK))}catch{return null}};
const clearS=()=>localStorage.removeItem(SK);

/* ── INIT ── */
async function init(){
  buildEmoji();

  // 100dvh fallback для старых браузеров
  setAppHeight();
  window.addEventListener('resize',setAppHeight);

  const sv=loadS();
  if(sv){
    try{
      const r=await fetch('/api/session/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:sv.t})});
      if(r.ok){
        const{ticket,messages}=await r.json();
        S.token=sv.t;S.tid=ticket.id;S.uname=ticket.user_name;
        showChat();renderMsgs(messages);scrollBot(false);socket.connect();
        if(ticket.status==='closed'){S.closed=true;markClosed();}
        return;
      }
      clearS(); // server rejected (ticket gone) — clear stored session
    }catch{showLogin();return;} // network error — keep session for next load
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
    S.token=sessionToken;S.tid=ticketId;S.uname=userName;
    saveS();showChat();renderMsgs([]);socket.connect();
  }catch{showToast('Ошибка подключения');sb.disabled=false;sl.textContent='Начать чат'}
});

function showLogin(){$('ls').classList.add('on');$('cs').classList.remove('on');setTimeout(()=>ni.focus(),150)}
function showChat(){$('ls').classList.remove('on');$('cs').classList.add('on')}

/* ── CLOSE ── */
hcl.addEventListener('click',()=>{
  if(S.closed)return;
  dlg('Закрыть обращение?','После закрытия вы не сможете писать. Можно переоткрыть в любое время.',async()=>{
    await fetch(`/api/tickets/${S.tid}/close`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:S.token})});
    markClosed();clearS();
  });
});
function markClosed(){S.closed=true;ia.style.display='none';cbar.style.display='flex';hcl.style.display='none'}

/* ── REOPEN ── */
reopenbtn.addEventListener('click',async()=>{
  try{
    const r=await fetch(`/api/tickets/${S.tid}/reopen`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionToken:S.token})});
    if(!r.ok)throw 0;
    S.closed=false;ia.style.display='';cbar.style.display='none';hcl.style.display='';
    saveS();socket.connect();showToast('Обращение переоткрыто');
  }catch{showToast('Ошибка — попробуйте снова')}
});

/* ── NEW CHAT ── */
newbtn.addEventListener('click',()=>{
  clearS();
  socket.disconnect();
  S.token=null;S.tid=null;S.uname=null;S.closed=false;S.lastDate=null;
  ml.innerHTML='';
  cbar.style.display='none';ia.style.display='';hcl.style.display='';
  ni.value='';sb.disabled=true;
  showLogin();
});

/* ── RENDER ── */
function renderMsgs(msgs){ml.innerHTML='';S.lastDate=null;if(!msgs.length){renderEmpty();return}msgs.forEach(renderMsg)}
function renderEmpty(){const d=document.createElement('div');d.className='emp';d.innerHTML=`<svg width="58" height="58" viewBox="0 0 58 58" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M29 6C16.3 6 6 15.3 6 27c0 6.3 2.9 12 7.6 16L12 52l9.5-2.8A23.5 23.5 0 0029 52c12.7 0 23-9.3 23-21S41.7 6 29 6Z"/><circle cx="20" cy="28" r="2" fill="currentColor" stroke="none"/><circle cx="29" cy="28" r="2" fill="currentColor" stroke="none"/><circle cx="38" cy="28" r="2" fill="currentColor" stroke="none"/></svg><p>Напишите ваш первый вопрос — ответим быстро</p>`;ml.appendChild(d)}
function renderSys(txt){ml.querySelector('.emp')?.remove();const d=document.createElement('div');d.className='sysmsg';d.innerHTML=`<span>${esc(txt)}</span>`;ml.appendChild(d)}

function renderMsg(msg){
  ml.querySelector('.emp')?.remove();
  if(msg.sender==='system'){renderSys(msg.content||'');return;}
  const dt=new Date(msg.created_at),ds=fmtDate(dt);
  if(ds!==S.lastDate){S.lastDate=ds;const s=document.createElement('div');s.className='dsp';s.innerHTML=`<span>${ds}</span>`;ml.appendChild(s)}
  const isO=msg.sender==='user';
  const w=document.createElement('div');w.className='msg '+(isO?'o':'i');
  let h='';
  if(!isO)h+=`<div class="bsnm">${esc(msg.sender_name)}</div>`;
  h+='<div class="bub">';
  if(msg.message_type==='image'&&msg.file_url){
    h+=`<img class="mimg" src="${msg.file_url}" loading="lazy" onclick="openLb(this)">`;
    if(msg.content)h+=`<div class="btxt" style="margin-top:5px">${esc(msg.content)}</div>`;
  }else if(msg.message_type==='video'&&msg.file_url){
    h+=`<video class="mvid" src="${msg.file_url}" controls preload="metadata"></video>`;
    if(msg.content)h+=`<div class="btxt" style="margin-top:5px">${esc(msg.content)}</div>`;
  }else if(msg.message_type==='audio'&&msg.file_url){
    h+=`<audio class="maud" src="${msg.file_url}" controls></audio>`;
  }else if(msg.file_url){
    h+=`<a class="mfile" href="${msg.file_url}" download="${esc(msg.file_name||'file')}" target="_blank"><div class="fic">${dico()}</div><div><div class="fnm">${esc(msg.file_name||'Файл')}</div></div></a>`;
    if(msg.content)h+=`<div class="btxt" style="margin-top:4px">${esc(msg.content)}</div>`;
  }else{h+=`<div class="btxt">${linkify(esc(msg.content||''))}</div>`}
  const tick=isO?`<svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="rgba(122,178,220,.6)" stroke-width="1.8" stroke-linecap="round"><path d="M1 5.5l3.5 3.5L14 1"/><path d="M6 9L14 1" opacity=".5"/></svg>`:'';
  h+=`<div class="bmeta">${tick}<span class="btime">${fmtTime(dt)}</span></div></div>`;
  w.innerHTML=h;ml.appendChild(w);
}

/* ── SEND ── */
async function send(){
  if(S.closed||S.uploading)return;
  const txt=ti.value.trim(),file=S.file;
  if(!txt&&!file)return;
  sndbtn.disabled=true;
  let fu=null,fn=null,fm=null,mt='text';
  if(file){
    S.uploading=true;showSpin(true);
    try{const fd=new FormData();fd.append('file',file);const r=await fetch('/api/upload',{method:'POST',body:fd});if(!r.ok)throw 0;const d=await r.json();fu=d.url;fn=d.name;fm=d.mime;mt=d.type}
    catch{showToast('Ошибка загрузки');S.uploading=false;showSpin(false);sndbtn.disabled=false;return}
    S.uploading=false;showSpin(false);clearFile();
  }
  ti.value='';resize();updSend();closeEp();
  socket.emit('send_message',{ticketId:S.tid,sessionToken:S.token,content:txt||null,fileUrl:fu,fileName:fn,fileMime:fm,messageType:mt},ack=>{
    if(ack?.error)showToast(ack.error==='Ticket is closed'?'Обращение закрыто':'Ошибка');
    sndbtn.disabled=false;updSend();
  });
}
sndbtn.addEventListener('click',send);
ti.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});
ti.addEventListener('input',()=>{resize();updSend()});
const updSend=()=>{sndbtn.disabled=!ti.value.trim()&&!S.file};
function resize(){ti.style.height='auto';ti.style.height=Math.min(ti.scrollHeight,108)+'px'}

/* ── FILES ── */
abt.addEventListener('click',()=>{closeEp();fi.click()});
fi.addEventListener('change',()=>{if(fi.files[0]){setFile(fi.files[0]);fi.value=''}});
mwrap.addEventListener('dragover',e=>{e.preventDefault();mwrap.style.outline='2px dashed #2ca5e0';mwrap.style.outlineOffset='-8px'});
mwrap.addEventListener('dragleave',()=>{mwrap.style.outline=''});
mwrap.addEventListener('drop',e=>{e.preventDefault();mwrap.style.outline='';if(e.dataTransfer.files[0])setFile(e.dataTransfer.files[0])});
document.addEventListener('paste',e=>{if(S.closed)return;for(const it of(e.clipboardData?.items||[])){if(it.kind==='file'){setFile(it.getAsFile());break}}});
function setFile(f){S.file=f;fp.style.display='block';fpth.innerHTML='';if(f.type.startsWith('image/')){const img=document.createElement('img');img.src=URL.createObjectURL(f);fpth.appendChild(img)}else{const d=document.createElement('div');d.className='fpnm';d.textContent=f.name;fpth.appendChild(d)}updSend()}
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

/* ── SCROLL ── */
const isBot=()=>mwrap.scrollHeight-mwrap.scrollTop-mwrap.clientHeight<120;
function scrollBot(smooth=true){requestAnimationFrame(()=>mwrap.scrollTo({top:mwrap.scrollHeight,behavior:smooth?'smooth':'auto'}));S.unread=0;updSDB()}
function updSDB(){
  const show=!isBot()||S.unread>0;
  sdwn.classList.toggle('on',show);
  let badge=sdwn.querySelector('.ubadge');
  if(S.unread>0){if(!badge){badge=document.createElement('div');badge.className='ubadge';sdwn.appendChild(badge)}badge.textContent=S.unread}
  else badge?.remove();
}
mwrap.addEventListener('scroll',updSDB,{passive:true});
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
let tt;function showToast(m,d=3200){clearTimeout(tt);tst.textContent=m;tst.classList.add('on');tt=setTimeout(()=>tst.classList.remove('on'),d)}

/* ── UTILS ── */
const esc=s=>s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):'';
const linkify=t=>t.replace(/(https?:\/\/[^\s<>"]+)/g,'<a href="$1" target="_blank" rel="noopener">$1</a>');
const fmtTime=d=>d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
function fmtDate(d){const n=new Date(),td=new Date(n.getFullYear(),n.getMonth(),n.getDate()),diff=Math.round((td-new Date(d.getFullYear(),d.getMonth(),d.getDate()))/86400000);if(diff===0)return'Сегодня';if(diff===1)return'Вчера';return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'})}
function dico(){return`<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="1" width="14" height="16" rx="2"/><path d="M5 6h8M5 9h8M5 12h5"/></svg>`}

/* prevent double-tap zoom */
let lt=0;document.addEventListener('touchend',e=>{const n=Date.now();if(n-lt<300&&e.target.tagName!=='TEXTAREA'&&e.target.tagName!=='INPUT')e.preventDefault();lt=n},{passive:false});

init();
