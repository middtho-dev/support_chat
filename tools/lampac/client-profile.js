(function(){'use strict';var p=POLICY,attempt=0;
function apply(){if(!window.Lampa||!Lampa.Storage){if(++attempt<120)setTimeout(apply,500);return;}
var s=Lampa.Storage,k='workspace_managed_preferences',old=s.get(k,{}),values={},device=s.get('workspace_device_access',{}),overrides=device.overrides||{};
Object.keys(p.mode==='disabled'?{}:p.values).forEach(function(key){values[key]=p.values[key];});
Object.keys(overrides).forEach(function(key){values[key]=overrides[key];});
var same=p.mode==='revision'&&old.revision===p.revision&&JSON.stringify(old.overrides||{})===JSON.stringify(overrides);
if(same&&!Object.keys(overrides).length){applyMenu(s);return;}
var backup=old.backup||{},last=old.values||{};
Object.keys(last).forEach(function(key){if(!(key in values)){if(String(s.get(key))===last[key]){if(backup[key]===null)s.remove(key);else s.set(key,backup[key]);}delete backup[key];}});
Object.keys(values).forEach(function(key){if(!(key in backup))backup[key]=localStorage.getItem(key);if(!same||key in overrides)s.set(key,values[key]);});
s.set(k,{revision:p.revision,backup:backup,values:values,overrides:overrides});
applyMenu(s);}
function applyMenu(s){
function denied(name){var known=['account','interface','player','parser','server','tmdb','plugins','parental_control','more','workspace_device'];return String(s.get('workspace_settings_all'))==='false'||String(s.get('workspace_settings_'+(known.indexOf(name)>=0?name:'other')))==='false';}
if(Lampa.Settings&&!window.workspaceSettingsGuard){
 window.workspaceSettingsGuard=true;
 var original=Lampa.Settings.create;
 Lampa.Settings.create=function(name){if(denied(name)){if(Lampa.Noty)Lampa.Noty.show('Настройки доступны в Workspace');return;}return original.apply(this,arguments);};
 Lampa.Settings.listener.follow('open',function(e){
  window.workspaceSettingsOpen=e.name;
  if(e.name==='main')e.body.find('[data-component]').each(function(){var item=window.$(this);var show=!denied(item.data('component'));item.toggle(show).toggleClass('selector',show);});
  else if(denied(e.name)){e.body.empty();setTimeout(function(){Lampa.Controller.toggle('settings');},0);}
 });
}
if(window.workspaceSettingsOpen&&window.workspaceSettingsOpen!=='main'&&denied(window.workspaceSettingsOpen)){window.workspaceSettingsOpen='main';Lampa.Controller.toggle('settings');}
if(typeof document!=='undefined'){
 var style=document.getElementById('workspace-menu-visibility');if(!style){style=document.createElement('style');style.id='workspace-menu-visibility';document.head.appendChild(style);}
 style.textContent=['movie','tv','cartoon','anime','catalog','history','favorite'].filter(function(key){return String(s.get('workspace_menu_'+key))==='false';}).map(function(key){return '.menu__item[data-action="'+key+'"]{display:none!important}';}).join('\n');
 if(String(s.get('workspace_settings_all'))==='false')style.textContent+='\n.open--settings,.settings-folder{display:none!important}';
}}
window.workspaceApplyProfile=apply;apply();})();
