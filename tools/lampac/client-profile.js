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
function denied(name){var known=['account','interface','player','parser','server','tmdb','plugins','parental_control','more','workspace_device'];return (name==='account'&&String(s.get('workspace_header_profile'))==='false')||String(s.get('workspace_settings_all'))==='false'||String(s.get('workspace_settings_'+(known.indexOf(name)>=0?name:'other')))==='false';}
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
 var header={profile:'.open--profile',search:'.open--search',notice:'.open--notice',feed:'.open--feed',premium:'.open--premium',broadcast:'.open--broadcast',fullscreen:'.full--screen',clock:'.head__time-now',date:'.head__time-date,.head__time-week',logo:'.head__logo-icon'};
 Object.keys(header).forEach(function(key){if(String(s.get('workspace_header_'+key))==='false'||key==='premium'&&String(s.get('workspace_header_profile'))==='false')style.textContent+='\n'+header[key].split(',').map(function(selector){return '.head '+selector;}).join(',')+'{display:none!important}';});
 var accent={cyan:'#45b9e9',violet:'#b398ff',amber:'#edbc64',mint:'#6cd5b5'}[s.get('workspace_home_accent')];
 if(accent)style.textContent+='\n.head .selector.focus,.menu .selector.focus{background:'+accent+'!important;color:#07111d!important}.head .selector.focus,.menu .selector.focus{outline:2px solid '+accent+';outline-offset:3px}';
 var surface={glass:'rgba(12,23,38,.84)',solid:'#101b2b'}[s.get('workspace_home_surface')];
 if(surface)style.textContent+='\n.head,.menu{background:'+surface+'!important}';
 var corners={soft:'18px',square:'0px'}[s.get('workspace_home_corners')];
 if(corners)style.textContent+='\n.head .selector,.menu .menu__item{border-radius:'+corners+'!important}';
 if(s.get('workspace_home_motion')==='reduced')style.textContent+='\n.head *,.menu *{transition:none!important;animation:none!important}';
 if(String(s.get('workspace_settings_all'))==='false')style.textContent+='\n.open--settings,.settings-folder{display:none!important}';
}}
window.workspaceApplyProfile=apply;apply();})();
