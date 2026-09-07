(function(){'use strict';
var config=DEVICE_CONFIG,tries=0,busy=false,timer=null;
function start(){
 if(!window.Lampa||!Lampa.SettingsApi||!Lampa.Storage){if(++tries<120)setTimeout(start,500);return;}
 if(window.workspaceDeviceControl)return;window.workspaceDeviceControl=true;
 var store=Lampa.Storage,key='workspace_device_access',state=store.get(key,{});
 function save(){store.set(key,state);}
 function note(text){Lampa.Noty.show(text);}
 function request(action,data,done){var xhr=new XMLHttpRequest();xhr.open('POST',config.url+'/workspace-device/'+action);xhr.timeout=12000;xhr.setRequestHeader('Content-Type','application/json');xhr.onload=function(){var result;try{result=JSON.parse(xhr.responseText);}catch(e){result={};}done(xhr.status,result);};xhr.onerror=xhr.ontimeout=function(){done(0,{});};xhr.send(JSON.stringify(data));}
 function snapshot(){var result={};Object.keys(config.fields).forEach(function(k){var value=String(store.get(k));if(config.fields[k].indexOf(value)>=0)result[k]=value;});return result;}
 function poll(){if(busy||!state.token)return;busy=true;var token=state.token;request('poll',{token:token,applied:state.applied||0,snapshot:snapshot()},function(status,data){busy=false;if(token!==state.token)return;if(status===403){state={};save();return;}if(status!==200)return;
  if(data.paired){state.paired=true;delete state.code;save();}
  if(data.paired&&data.revision>(state.applied||0)){
   Object.keys(data.values).forEach(function(k){if(config.fields[k]&&config.fields[k].indexOf(data.values[k])>=0)store.set(k,data.values[k]);});
   state.applied=data.revision;save();note('Workspace: настройки применены');
   setTimeout(poll,100);if(data.reload)setTimeout(function(){window.location.reload();},1800);
  }
 });}
 function showCode(){Lampa.Modal.open({title:'Подключение к Workspace',html:window.$('<div class="about"></div>').text('Код: '+state.code+' · действует 5 минут. Введите его в панели: Lampac → Устройства ТВ.'),size:'small',onBack:function(){Lampa.Modal.close();Lampa.Controller.toggle('settings_component');}});}
 function pair(){if(state.paired){note('Устройство связано с Workspace. Управление доступно в панели.');return;}if(state.code&&state.expires>Date.now()){showCode();return;}if(busy)return;busy=true;
 request('register',{name:String(store.get('device_name')||'Lampa TV').slice(0,80)},function(status,data){busy=false;if(status!==200){note(data.error||'Не удалось получить код Workspace');return;}state={token:data.token,code:data.code,expires:Date.now()+data.expiresIn*1000,applied:0};save();showCode();poll();});}
 Lampa.SettingsApi.addComponent({component:'workspace_device',name:'Workspace',icon:'<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 21h8m-4-4v4" stroke="currentColor" stroke-width="2"/></svg>'});
 Lampa.SettingsApi.addParam({component:'workspace_device',param:{name:'workspace_pair',type:'button'},field:{name:'Подключить к панели по коду',description:'Разрешить просмотр и изменение настроек этого устройства'},onChange:pair});
 Lampa.SettingsApi.addParam({component:'workspace_device',param:{name:'workspace_forget',type:'button'},field:{name:'Отключить управление на этом устройстве',description:'Для повторного подключения потребуется новый код'},onChange:function(){state={};store.remove(key);note('Удалённое управление отключено');}});
 timer=setInterval(poll,10000);poll();
}
start();})();
