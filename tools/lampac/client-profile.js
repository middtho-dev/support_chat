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
 if(window.workspaceLiveTheme===undefined?String(s.get('workspace_kv9_theme'))==='true':window.workspaceLiveTheme)style.textContent+='\nbody{background:#050B10!important;color:#E6F2F3!important}body .background{opacity:.32!important}body .head,body .menu,body.black--style .settings__content,body.black--style .modal__content,body.black--style .selectbox__content,body .settings__content,body .selectbox__content,body .modal__content,body .search{background:rgba(14,26,34,.97)!important;color:#E6F2F3!important;border-color:rgba(46,211,183,.18)!important}body .head{border-bottom:1px solid rgba(46,211,183,.18)}body .menu{border-right:1px solid rgba(46,211,183,.18)}body .settings__content,body .selectbox__content,body .modal__content{border-radius:1em;box-shadow:0 1em 4em #0009}body .card__view,body .full-start__poster,body .full-start-new__poster,body .card-episode__body{border-radius:.8em;overflow:hidden;box-shadow:0 .3em 1.2em #0005}body .menu__item,body .head__action,body .settings-param,body .settings-folder,body .selectbox-item,body .full-start__button,body .modal__button,body .navigation-tabs__button{border-radius:.65em;transition:background .2s ease,color .2s ease,box-shadow .2s ease}body .menu__item.focus,body .head__action.focus,body .settings-param.focus,body .settings-folder.focus,body .selectbox-item.focus,body .full-start__button.focus,body .modal__button.focus,body .navigation-tabs__button.focus,body .search-source__tab.focus{background:#2ED3B7!important;color:#050B10!important;box-shadow:0 0 1.2em #2ed3b740}body .card.focus .card__view::after{border-color:#2ED3B7!important}body .card.focus .card__view{outline:.15em solid #2ED3B7;outline-offset:.2em;box-shadow:0 0 1.6em #2ed3b745}body .card__title,body .full-start__title,body .full-start-new__title,body .modal__title,body .settings__head{color:#E6F2F3!important}body .settings-param__descr,body .selectbox-item__subtitle,body .head__time-date{color:#8FA7AD!important}body .settings-param__value,body .head__time-now{color:#2ED3B7}body .player-panel{background:linear-gradient(0deg,rgba(5,11,16,.98),rgba(14,26,34,.86))!important}body .player-panel .focus{color:#2ED3B7!important}body .player-panel__position,body .player-panel__played{background:#2ED3B7!important}body .modal__content,body .settings__content,body .selectbox__content{animation:kv9-appear .24s ease-out}body .card__view{transition:box-shadow .2s ease,outline-color .2s ease}body .navigation-bar{background:#0E1A22!important;border-top:1px solid #2ed3b730}body .navigation-bar__item.active{color:#2ED3B7!important}@keyframes kv9-appear{from{opacity:0;transform:translateY(.4em)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){body .modal__content,body .settings__content,body .selectbox__content{animation:none}body .card__view,body .menu__item,body .head__action,body .settings-param,body .settings-folder,body .selectbox-item,body .full-start__button,body .modal__button,body .navigation-tabs__button{transition:none}}';
 if(String(s.get('workspace_settings_all'))==='false')style.textContent+='\n.open--settings,.settings-folder{display:none!important}';
}}
window.workspaceApplyTheme=function(enabled){var s=Lampa.Storage,device=s.get('workspace_device_access',{}),value=(device.overrides||{}).workspace_kv9_theme;window.workspaceLiveTheme=value===undefined?enabled:String(value)==='true';applyMenu(s);};
window.workspaceApplyProfile=apply;apply();})();
