(function(){'use strict';
var config=DEVICE_CONFIG,tries=0,busy=false,timer=null;
function start(){
 if(!window.Lampa||!Lampa.SettingsApi||!Lampa.Storage){if(++tries<120)setTimeout(start,500);return;}
 if(window.workspaceDeviceControl)return;window.workspaceDeviceControl=true;
 var store=Lampa.Storage,key='workspace_device_access',state=store.get(key,{});
 function save(){store.set(key,state);if(state.token&&window.location&&window.location.origin===config.url){document.cookie='workspace_device='+encodeURIComponent(state.token)+'; Path=/; Max-Age=31536000; SameSite=Lax; Secure';}}
 delete state.paused;delete state.revoked;
 function access(enabled){
  var cover=document.getElementById('workspace-access-disabled');
  if(enabled===false){
   if(!cover){var host=document.createElement('div');host.id='workspace-activation-host';host.innerHTML=config.activation;document.body.appendChild(host);cover=document.getElementById('workspace-access-disabled');if(cover){var link=cover.querySelector('a');if(link)link.focus();}}
   if(cover){var label=cover.querySelector('[data-workspace-id]');if(label)label.textContent=state.id||'Подключение…';}
   Array.prototype.forEach.call(document.querySelectorAll('video'),function(v){v.pause();});
  }else if(cover){var host=document.getElementById('workspace-activation-host');if(host)host.remove();else cover.remove();}
 }
 if(window.addEventListener)window.addEventListener('keydown',function(e){var cover=document.getElementById('workspace-access-disabled');if(!cover)return;e.stopImmediatePropagation();if(e.key==='Tab'){e.preventDefault();var link=cover.querySelector('a');if(link)link.focus();}else if(!(e.key==='Enter'&&e.target.tagName==='A'))e.preventDefault();},true);
 function enroll(){if(busy||state.token||state.paused||state.revoked)return;busy=true;request('enroll',{name:String(store.get('device_name')||'Lampa').slice(0,80)},function(status,data){busy=false;if(status!==200)return;state={token:data.token,id:data.id,paired:true,applied:0,overrides:{},enabled:data.enabled};save();if(data.enabled===false)access(false);poll();});}
 function note(text){Lampa.Noty.show(text);}
 function request(action,data,done){var xhr=new XMLHttpRequest();xhr.open('POST',config.url+'/workspace-device/'+action);xhr.timeout=12000;xhr.setRequestHeader('Content-Type','application/json');xhr.onload=function(){var result;try{result=JSON.parse(xhr.responseText);}catch(e){result={};}done(xhr.status,result);};xhr.onerror=xhr.ontimeout=function(){done(0,{});};xhr.send(JSON.stringify(data));}
 var announcements=window.createWorkspaceAnnouncements?window.createWorkspaceAnnouncements({store:store,request:request,logo:config.logo}):null;
 function snapshot(){var result={};Object.keys(config.fields).forEach(function(k){var value=String(store.get(k));if(config.fields[k].indexOf(value)>=0)result[k]=value;});return result;}
 function poll(){if(state.paused||state.revoked)return;if(!state.token){enroll();return;}if(busy)return;busy=true;var token=state.token;request('poll',{token:token,applied:state.applied||0,snapshot:snapshot()},function(status,data){busy=false;if(token!==state.token||state.paused)return;if(status===403){if(announcements)announcements.update(null,token,state.id,false);access(false);if(data.code==='device_revoked'){state={applied:0,overrides:{},enabled:false};save();enroll();}return;}if(status!==200)return;
  if(data.paired){state.paired=true;state.id=data.id||state.id;state.name=data.name||state.name;delete state.code;
   var changed=JSON.stringify(state.overrides||{})!==JSON.stringify(data.overrides||{});state.overrides=data.overrides||{};save();
   if(typeof data.kv9Theme==='boolean'&&window.workspaceApplyTheme)window.workspaceApplyTheme(data.kv9Theme);
   else if(changed&&window.workspaceApplyProfile)window.workspaceApplyProfile();
  }
  var activated=state.enabled===false&&data.enabled===true;state.enabled=data.enabled;save();access(data.enabled);if(activated){window.location.reload();return;}
  if(announcements)announcements.update(data.announcement,token,state.id,data.enabled);
  if(data.paired&&data.revision>(state.applied||0)){
   if(window.workspaceApplyProfile)window.workspaceApplyProfile();else Object.keys(data.values).forEach(function(k){if(config.fields[k]&&config.fields[k].indexOf(data.values[k])>=0)store.set(k,data.values[k]);});
   state.applied=data.revision;save();note('Workspace: настройки применены');
   setTimeout(poll,100);if(data.reload)setTimeout(function(){window.location.reload();},1800);
  }
 });}
 Lampa.SettingsApi.addComponent({component:'workspace_device',name:'Workspace',icon:'<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8m-4-4v4" stroke="currentColor" stroke-width="2"/></svg>'});
 Lampa.SettingsApi.addParam({component:'workspace_device',param:{name:'workspace_info',type:'static'},field:{name:'Устройство в Workspace',description:'Подключение автоматическое. Управление доступно администратору в Workspace.'},onRender:function(item){item.removeClass('selector');item.find('.settings-param__name').text(state.name||'Устройство в Workspace');item.find('.settings-param__descr').text('ID: '+(state.id||'Подключение…')+' · '+(state.revoked?'Доступ отозван':state.enabled===false?'Ожидает активации':'Подключено')+' · '+config.url);}});
 if(state.code&&!state.paired)state={};save();if(state.enabled===false)access(false);timer=setInterval(poll,10000);poll();
}
start();})();
