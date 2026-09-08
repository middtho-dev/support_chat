'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../tools/lampac/ui-controls.js'),'utf8');
test('individual settings remain reachable inside blocked sections and device overrides win',()=>{
 const data=new Map(), context={document:{querySelectorAll:()=>[]},Lampa:{Storage:{get:(k,f)=>data.has(k)?data.get(k):f},Template:{get:()=>null},Lang:{translate:s=>s},SettingsApi:{allComponents:()=>({database:{name:'Хранилище'}}),allParams:()=>({database:[{param:{type:'static',name:'cache_reset'},field:{name:'Очистить кеш'}},{param:{type:'title'},field:{name:'Заголовок'}},{param:{type:'trigger',name:'sync'},field:{name:'Синхронизация'}}]})}}};context.window=context;
 vm.runInNewContext(source,context);const api=context.workspaceUIControls;
 const controls=api.inventory();const cache=controls.find(c=>c.label==='Очистить кеш'),sync=controls.find(c=>c.label==='Синхронизация');
 assert.ok(cache);assert.ok(sync);assert.equal(controls.some(c=>c.label==='Заголовок'),false);
 api.update({workspace_settings_all:'false'});assert.equal(api.deniedSection('database'),true);assert.equal(api.deniedSection('main'),true);
 api.update({workspace_settings_all:'false',[cache.key]:'true'});assert.equal(api.deniedSection('database'),false);assert.equal(api.deniedSection('main'),false);assert.equal(api.deniedSection('player'),true);
 data.set('workspace_device_access',{overrides:{[cache.key]:'false'}});assert.equal(api.deniedSection('database'),true);
 api.update({});assert.equal(api.deniedSection('database'),false);
 assert.match(cache.key,/^workspace_ui_i_[a-f0-9]{16}$/);
});
test('unnamed Lampa action buttons are controlled separately and native visibility survives polling',()=>{
 function row(title){const attrs={'data-name':'undefined'},css=new Map(),classes=new Set(['selector']);return {textContent:title,getAttribute:k=>attrs[k]||null,querySelector:()=>({textContent:title}),style:{getPropertyValue:k=>css.get(k)||'',getPropertyPriority:()=>'',setProperty:(k,v)=>css.set(k,v)},classList:{contains:k=>classes.has(k),add:k=>classes.add(k),remove:k=>classes.delete(k)}};}
 const cache=row('Очистить кеш'),history=row('Очистить историю'),body={querySelectorAll:()=>[cache,history]},context={document:{querySelectorAll:selector=>selector==='.settings__content'?[body]:[]},workspaceSettingsOpen:'database',Lampa:{Storage:{get:(k,f)=>f},Template:{get:()=>null},Lang:{translate:s=>s},SettingsApi:{allComponents:()=>({database:{name:'Хранилище'}}),allParams:()=>({database:['Очистить кеш','Очистить историю'].map(name=>({param:{type:'button'},field:{name}}))})}}};context.window=context;
 vm.runInNewContext(source,context);const api=context.workspaceUIControls,items=api.inventory().filter(x=>x.group==='Видимость · Хранилище');assert.equal(items.length,2);
 const key=items.find(x=>x.label==='Очистить кеш').key;
 api.update({workspace_settings_all:'false',[key]:'true'});assert.notEqual(cache.style.getPropertyValue('display'),'none');assert.equal(history.style.getPropertyValue('display'),'none');assert.equal(cache.classList.contains('selector'),true);assert.equal(history.classList.contains('selector'),false);
 api.update({});assert.equal(history.classList.contains('selector'),true);
 history.style.setProperty('display','none');api.apply();assert.equal(history.style.getPropertyValue('display'),'none');
});
