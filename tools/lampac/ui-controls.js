(function(){'use strict';
if(window.workspaceUIControls)return;
var registry={},sectionLabels={},shared=null,hooked=false,queued=false;
function id(kind,text){var a=2166136261,b=2246822519;for(var i=0;i<text.length;i++){a=Math.imul(a^text.charCodeAt(i),16777619);b=Math.imul(b^text.charCodeAt(i),3266489917);}function hex(n){return ('00000000'+(n>>>0).toString(16)).slice(-8);}return 'workspace_ui_'+kind+'_'+hex(a)+hex(b);}
function clean(text){return String(text||'').replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim().slice(0,120);}
function label(text){return clean(window.Lampa&&Lampa.Lang?Lampa.Lang.translate(text):text);}
function add(kind,identity,title,group,section){var key=id(kind,identity);if(!registry[key]&&Object.keys(registry).length<500)registry[key]={key:key,label:clean(title)||identity,group:clean(group),section:section,kind:kind};return key;}
function value(key){var s=Lampa.Storage,device=s.get('workspace_device_access',{}),overrides=device.overrides||{};if(Object.prototype.hasOwnProperty.call(overrides,key))return overrides[key];if(shared!==null)return shared[key];var managed=s.get('workspace_managed_preferences',{});return (managed.values||{})[key];}
function blocked(section){var explicit=value(id('s',section));if(explicit!==undefined)return String(explicit)==='false';if(String(value('workspace_settings_all'))==='false')return true;var known=['account','interface','player','parser','server','tmdb','plugins','parental_control','more','workspace_device'];return String(value('workspace_settings_'+(known.indexOf(section)>=0?section:'other')))==='false';}
function deniedSection(section){if(section==='main')return !Object.keys(registry).some(function(k){return registry[k].kind==='s'&&!deniedSection(registry[k].section);});if(!blocked(section))return false;return !Object.keys(registry).some(function(k){return registry[k].kind==='i'&&registry[k].section===section&&String(value(k))==='true';});}
function visible(node,show){var old=node.__workspaceVisibility;if(show){if(!old)return;node.style.setProperty('display',old.display,old.priority);if(old.selector)node.classList.add('selector');delete node.__workspaceVisibility;}else{if(!old)node.__workspaceVisibility={display:node.style.getPropertyValue('display'),priority:node.style.getPropertyPriority('display'),selector:node.classList.contains('selector')};node.style.setProperty('display','none','important');node.classList.remove('selector');}}
function itemKey(node,section){var title=clean((node.querySelector('.settings-param__name,.settings-folder__name')||node).textContent),name=node.getAttribute('data-name')||node.getAttribute('data-id')||title;if(name==='undefined'||name==='null')name=title;return add('i',section+'|'+name,title,'Пункты: '+(sectionLabels[section]||section),section);}
function scanBody(body,section,apply){body.querySelectorAll('.settings-param').forEach(function(node){var key=itemKey(node,section);if(apply){var v=value(key);visible(node,v===undefined?!blocked(section):String(v)==='true');}});}
function discover(){if(!window.Lampa||!Lampa.Storage||!Lampa.Template)return;
 var components={account:{name:'Аккаунт'},interface:{name:'Интерфейс'},player:{name:'Плеер'},parser:{name:'Парсер'},server:{name:'TorrServer'},tmdb:{name:'TMDB'},plugins:{name:'Плагины'},more:{name:'Дополнительно'}};
 var api=Lampa.SettingsApi;if(api&&api.allComponents)Object.assign(components,api.allComponents());
 Object.keys(components).forEach(function(section){sectionLabels[section]=label(components[section].name)||section;add('s',section,label(components[section].name)||section,'Разделы настроек',section);try{var tpl=Lampa.Template.get('settings_'+section);var body=tpl&&tpl[0];if(body)scanBody(body,section,false);}catch(e){}});
 var params=api&&api.allParams?api.allParams():{};Object.keys(params).forEach(function(section){params[section].forEach(function(p){var title=label(p.field&&p.field.name);if(title&&p.param&&p.param.type!=='title')add('i',section+'|'+(p.param.type==='static'?title:p.param.name||title),title,'Пункты: '+(sectionLabels[section]||section),section);});});
 document.querySelectorAll('.menu__item').forEach(function(node){var title=clean((node.querySelector('.menu__text')||node).textContent),action=node.getAttribute('data-action')||title;var key=add('m',action,title,'Пункты левого меню','');var v=value(key);if(v===undefined)v=value('workspace_menu_'+action);visible(node,String(v)!=='false');});
}
function apply(){if(!window.Lampa||!Lampa.Storage||typeof document==='undefined')return;discover();
 document.querySelectorAll('.settings [data-component]').forEach(function(node){visible(node,!deniedSection(node.getAttribute('data-component')));});
 var section=window.workspaceSettingsOpen;if(section&&section!=='main')document.querySelectorAll('.settings__content').forEach(function(body){scanBody(body,section,true);});
 if(!hooked&&Lampa.Settings&&Lampa.Settings.listener){hooked=true;Lampa.Settings.listener.follow('open',function(e){window.workspaceSettingsOpen=e.name;setTimeout(function(){if(e.body&&e.body[0]&&e.name!=='main')scanBody(e.body[0],e.name,true);apply();},0);});}
}
function schedule(){if(queued)return;queued=true;setTimeout(function(){queued=false;apply();},100);}
window.workspaceUIControls={apply:apply,deniedSection:deniedSection,update:function(values){shared=values;apply();},inventory:function(){apply();return Object.keys(registry).map(function(k){var r=registry[k];return {key:r.key,label:r.label,group:r.group};});}};
if(typeof MutationObserver!=='undefined'&&typeof document!=='undefined'){new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true});}
})();
