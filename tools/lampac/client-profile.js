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
if(typeof document!=='undefined'){
 var style=document.getElementById('workspace-menu-visibility');if(!style){style=document.createElement('style');style.id='workspace-menu-visibility';document.head.appendChild(style);}
 style.textContent=['movie','tv','cartoon','anime','catalog','history','favorite'].filter(function(key){return String(s.get('workspace_menu_'+key))==='false';}).map(function(key){return '.menu__item[data-action="'+key+'"]{display:none!important}';}).join('\n');
}}
window.workspaceApplyProfile=apply;apply();})();
