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
  if(!style){style=node('style','');style.id='workspace-announcement-style';style.textContent='#workspace-announcement{position:fixed;inset:0;top:0;right:0;bottom:0;left:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:4vh 4vw;background:rgba(5,12,20,.94);box-sizing:border-box;color:#e8f0f8;font:18px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}#workspace-announcement *{box-sizing:border-box}.wa-notice-card{width:100%;height:100%;display:flex;flex-direction:column;min-height:0;padding:32px;padding:clamp(20px,4vw,64px);border:1px solid #ffffff20;border-radius:28px;background:linear-gradient(145deg,#183044,#111c2a);box-shadow:0 30px 100px #0008}.wa-notice-brand{display:flex;align-items:center;gap:16px;flex-shrink:0;color:#86a4bb;font-size:14px;letter-spacing:.06em}.wa-notice-brand img{width:64px;height:64px;object-fit:contain;border-radius:14px}.wa-notice-title{font-size:32px;font-size:clamp(24px,3.4vw,48px);line-height:1.2;max-height:25vh;overflow:auto;margin:24px 0 18px;overflow-wrap:anywhere;flex-shrink:0}.wa-notice-text{white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto;flex:1;min-height:0;margin:0 0 24px;padding-right:8px;font-size:clamp(17px,2vw,28px)}.wa-notice-close{align-self:flex-end;flex-shrink:0;min-width:180px;max-width:100%;border:0;border-radius:14px;background:#2b9fd4;color:#fff;font:inherit;font-weight:600;font-size:18px;line-height:1.4;padding:16px 28px;white-space:normal;overflow-wrap:anywhere;cursor:pointer}.wa-notice-close:focus{outline:3px solid #b6e8ff;outline-offset:5px}@media(max-width:600px){#workspace-announcement{padding:16px}.wa-notice-card{border-radius:20px;padding:22px}.wa-notice-brand img{width:48px;height:48px}.wa-notice-close{width:100%}.wa-notice-title{margin-top:20px}}';document.head.appendChild(style);}
  previous=document.activeElement;
  modal=node('div','');modal.id='workspace-announcement';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','workspace-announcement-title');
  var card=node('section','wa-notice-card'),brand=node('div','wa-notice-brand'),logo=node('img','');logo.src=options.logo;logo.alt='KV9';brand.appendChild(logo);brand.appendChild(node('span','','ОБЪЯВЛЕНИЕ'));
  var title=node('h1','wa-notice-title',item.title);title.id='workspace-announcement-title';
  var text=node('div','wa-notice-text',item.message),button=node('button','wa-notice-close',item.button);button.type='button';button.onclick=close;
  card.appendChild(brand);card.appendChild(title);card.appendChild(text);card.appendChild(button);modal.appendChild(card);document.body.appendChild(modal);button.focus();
  receipts[item.id]=item.occurrence;
  var keys=Object.keys(receipts);while(keys.length>200)delete receipts[keys.shift()];
  options.store.set(receiptKey,{device:device,shown:receipts});ack(item,token);
 }};
};
})();
