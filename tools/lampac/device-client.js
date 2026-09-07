(function(){'use strict';
var config=DEVICE_CONFIG,tries=0,busy=false,timer=null;
function start(){
 if(!window.Lampa||!Lampa.SettingsApi||!Lampa.Storage){if(++tries<120)setTimeout(start,500);return;}
 if(window.workspaceDeviceControl)return;window.workspaceDeviceControl=true;
 var store=Lampa.Storage,key='workspace_device_access',state=store.get(key,{});
 function save(){store.set(key,state);if(state.token&&window.location&&window.location.origin===config.url){document.cookie='workspace_device='+encodeURIComponent(state.token)+'; Path=/; Max-Age=31536000; SameSite=Lax; Secure';}}
 function access(enabled){
  var cover=document.getElementById('workspace-access-disabled');
  if(enabled===false){if(!cover){cover=document.createElement('div');cover.id='workspace-access-disabled';cover.textContent='Доступ к Lampac отключён администратором';cover.style.cssText='position:fixed;inset:0;z-index:2147483647;background:#101827;color:#fff;display:flex;align-items:center;justify-content:center;padding:40px;text-align:center;font-size:24px';document.body.appendChild(cover);}Array.prototype.forEach.call(document.querySelectorAll('video'),function(v){v.pause();});}
  else if(cover)cover.remove();
 }
 function enroll(){if(busy||state.token||state.paused||state.revoked)return;busy=true;request('enroll',{name:String(store.get('device_name')||'Lampa').slice(0,80)},function(status,data){busy=false;if(status!==200)return;state={token:data.token,id:data.id,paired:true,applied:0,overrides:{}};save();poll();});}
 function note(text){Lampa.Noty.show(text);}
 function request(action,data,done){var xhr=new XMLHttpRequest();xhr.open('POST',config.url+'/workspace-device/'+action);xhr.timeout=12000;xhr.setRequestHeader('Content-Type','application/json');xhr.onload=function(){var result;try{result=JSON.parse(xhr.responseText);}catch(e){result={};}done(xhr.status,result);};xhr.onerror=xhr.ontimeout=function(){done(0,{});};xhr.send(JSON.stringify(data));}
 function snapshot(){var result={};Object.keys(config.fields).forEach(function(k){var value=String(store.get(k));if(config.fields[k].indexOf(value)>=0)result[k]=value;});return result;}
 function poll(){if(state.paused||state.revoked)return;if(!state.token){enroll();return;}if(busy)return;busy=true;var token=state.token;request('poll',{token:token,applied:state.applied||0,snapshot:snapshot()},function(status,data){busy=false;if(token!==state.token||state.paused)return;if(status===403){state.revoked=true;save();return;}if(status!==200)return;
  if(data.paired){state.paired=true;state.id=data.id||state.id;state.name=data.name||state.name;delete state.code;
   var changed=JSON.stringify(state.overrides||{})!==JSON.stringify(data.overrides||{});state.overrides=data.overrides||{};save();
   if(changed&&window.workspaceApplyProfile)window.workspaceApplyProfile();
  }
  access(data.enabled);
  if(data.paired&&data.revision>(state.applied||0)){
   if(window.workspaceApplyProfile)window.workspaceApplyProfile();else Object.keys(data.values).forEach(function(k){if(config.fields[k]&&config.fields[k].indexOf(data.values[k])>=0)store.set(k,data.values[k]);});
   state.applied=data.revision;save();note('Workspace: настройки применены');
   setTimeout(poll,100);if(data.reload)setTimeout(function(){window.location.reload();},1800);
  }
 });}
 function pair(){if(state.revoked){note('Привязка удалена администратором');return;}state.paused=false;save();if(state.id)note('Workspace ID: '+state.id+' · '+(state.name||'Lampa'));else note('Подключение к Workspace…');poll();}
 Lampa.SettingsApi.addComponent({component:'workspace_device',name:'Workspace',icon:'<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8m-4-4v4" stroke="currentColor" stroke-width="2"/></svg>'});
 Lampa.SettingsApi.addParam({component:'workspace_device',param:{name:'workspace_pair',type:'button'},field:{name:'Устройство в Workspace',description:'Подключение автоматическое. Показать ID устройства и возобновить управление'},onChange:pair});
 Lampa.SettingsApi.addParam({component:'workspace_device',param:{name:'workspace_forget',type:'button'},field:{name:'Приостановить удалённое управление',description:'ID и индивидуальные настройки сохраняются'},onChange:function(){state.paused=true;save();note('Удалённое управление приостановлено');}});
 if(state.code&&!state.paired)state={};save();timer=setInterval(poll,10000);poll();
}
start();})();
