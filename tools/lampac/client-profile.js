(function(){'use strict';var p=POLICY,attempt=0;
function apply(){if(!window.Lampa||!Lampa.Storage){if(++attempt<120)setTimeout(apply,500);return;}
var s=Lampa.Storage,k='workspace_managed_preferences',old=s.get(k,{}),values=p.mode==='disabled'?{}:p.values;
if(p.mode==='revision'&&old.revision===p.revision)return;
var backup=old.backup||{},last=old.values||{};
Object.keys(last).forEach(function(key){if(!(key in values)){if(String(s.get(key))===last[key]){if(backup[key]===null)s.remove(key);else s.set(key,backup[key]);}delete backup[key];}});
Object.keys(values).forEach(function(key){if(!(key in backup))backup[key]=localStorage.getItem(key);s.set(key,values[key]);});
s.set(k,{revision:p.revision,backup:backup,values:values});}
apply();})();
