(function(){'use strict';
window.createWorkspaceAnnouncements=function(options){
 var modal=null,previous=null,device='',receiptKey='workspace_announcement_receipts',receipts={};
 function close(){if(modal){modal.remove();modal=null;if(previous&&document.documentElement.contains(previous))previous.focus();}}
 function ack(item,token){options.request('announcement-ack',{token:token,id:item.id,occurrence:item.occurrence},function(){});}
 function node(tag,className,text){var el=document.createElement(tag);el.className=className;if(text!==undefined)el.textContent=text;return el;}
 window.addEventListener('keydown',function(e){
  if(!modal||document.getElementById('workspace-access-disabled'))return;
  e.stopImmediatePropagation();e.preventDefault();
  if(e.key==='Enter'||e.key===' '||e.key==='Escape'||e.key==='Backspace'||e.keyCode===13||e.keyCode===10009||e.keyCode===461)close();
  else if(modal){var content=modal.querySelector('.wa-notice-text');if(e.key==='ArrowDown'||e.keyCode===40||e.keyCode===34)content.scrollTop+=content.clientHeight*.65;else if(e.key==='ArrowUp'||e.keyCode===38||e.keyCode===33)content.scrollTop-=content.clientHeight*.65;modal.querySelector('button').focus();}
 },true);
 return {update:function(item,token,id,enabled){
  if(device!==id){close();device=id;var saved=options.store.get(receiptKey,{});receipts=saved.device===id?saved.shown||{}:{};}
  if(!enabled){close();return;}
  if(!item)return;
  if((receipts[item.id]||0)>=item.occurrence){ack(item,token);return;}
  if(modal)return;
  var style=document.getElementById('workspace-announcement-style');
  if(!style){style=node('style','');style.id='workspace-announcement-style';style.textContent='#workspace-announcement{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(3,8,16,.38);box-sizing:border-box;color:#edf6ff;font:18px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;isolation:isolate}#workspace-announcement *{box-sizing:border-box}#workspace-announcement .wa-notice-card{width:78vw;height:77vh;max-width:1600px;display:flex;flex-direction:column;align-items:center;min-height:0;padding:clamp(16px,3vh,40px) clamp(20px,4vw,72px);border:1px solid rgba(180,220,255,.22);border-radius:28px;background:rgba(14,27,43,.9);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);box-shadow:0 28px 100px #0009;text-align:center}#workspace-announcement .wa-notice-brand{display:flex;flex-direction:column;align-items:center;gap:8px;flex-shrink:0;color:#9cbbd0;font-size:12px;letter-spacing:.18em}#workspace-announcement .wa-notice-brand img{width:clamp(40px,9vh,96px);height:clamp(40px,9vh,96px);object-fit:contain}#workspace-announcement .wa-notice-title{font-size:clamp(22px,3vw,44px);line-height:1.2;max-height:17vh;overflow:auto;width:100%;margin:16px 0;overflow-wrap:anywhere;flex-shrink:0}#workspace-announcement .wa-notice-text{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;flex:1;min-height:0;width:100%;margin:0 0 20px;padding:0 8px;font-size:clamp(16px,1.8vw,28px);scrollbar-width:thin}#workspace-announcement .wa-notice-close{align-self:center;flex-shrink:0;min-width:180px;max-width:100%;border:1px solid #72ccf5;border-radius:14px;background:#259acb;color:#fff;font:inherit;font-weight:600;padding:12px 32px;white-space:normal;overflow-wrap:anywhere;cursor:pointer}#workspace-announcement .wa-notice-close:focus{outline:3px solid #c2edff;outline-offset:5px;box-shadow:0 0 30px #39baff55}@media(max-width:600px){#workspace-announcement .wa-notice-card{width:92vw;height:66vh;border-radius:20px;padding:18px}#workspace-announcement .wa-notice-title{margin:12px 0}#workspace-announcement .wa-notice-close{min-width:140px}}@media(max-height:450px){#workspace-announcement .wa-notice-card{height:88vh;padding:12px 24px}#workspace-announcement .wa-notice-brand img{width:32px;height:32px}#workspace-announcement .wa-notice-brand span{display:none}#workspace-announcement .wa-notice-title{font-size:20px;margin:8px 0}#workspace-announcement .wa-notice-text{font-size:16px;margin-bottom:10px}#workspace-announcement .wa-notice-close{padding:8px 24px}}';document.head.appendChild(style);}
  previous=document.activeElement;
  modal=node('div','');modal.id='workspace-announcement';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','workspace-announcement-title');modal.setAttribute('aria-describedby','workspace-announcement-message');
  var card=node('section','wa-notice-card'),brand=node('div','wa-notice-brand'),logo=node('img','');logo.src=options.logo;logo.alt='KV9';brand.appendChild(logo);brand.appendChild(node('span','','ОБЪЯВЛЕНИЕ'));
  var title=node('h1','wa-notice-title',item.title);title.id='workspace-announcement-title';
  var text=node('div','wa-notice-text',item.message),button=node('button','wa-notice-close',item.button);text.id='workspace-announcement-message';button.type='button';button.onclick=close;
  card.appendChild(brand);card.appendChild(title);card.appendChild(text);card.appendChild(button);modal.appendChild(card);document.body.appendChild(modal);button.focus();
  receipts[item.id]=item.occurrence;
  var keys=Object.keys(receipts);while(keys.length>200)delete receipts[keys.shift()];
  options.store.set(receiptKey,{device:device,shown:receipts});ack(item,token);
 }};
};
})();
