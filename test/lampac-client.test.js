'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../tools/lampac/client-profile.js'),'utf8');
test('Lampa profiles apply per revision and release boolean/number preferences without overwriting user changes',()=>{
  const data=new Map([['screensaver','true'],['screensaver_time','10']]);
  const storage={
    get(key,empty){const value=data.get(key);if(value===undefined)return empty||'';try{return JSON.parse(value);}catch{return value;}},
    set(key,value){data.set(key,typeof value==='object'?JSON.stringify(value):String(value));},
    remove(key){data.delete(key);}
  };
  const context={Lampa:{Storage:storage},localStorage:{getItem:key=>data.get(key)??null}};context.window=context;
  const run=policy=>vm.runInNewContext(script.replace('POLICY',JSON.stringify(policy)),context);
  run({mode:'revision',revision:'1',values:{screensaver:'false',screensaver_time:'5',source:'tmdb'}});
  assert.equal(storage.get('screensaver'),false);assert.equal(storage.get('screensaver_time'),5);
  storage.set('source','cub');
  run({mode:'revision',revision:'1',values:{source:'tmdb'}});
  assert.equal(storage.get('source'),'cub');
  run({mode:'disabled',revision:'2',values:{}});
  assert.equal(storage.get('screensaver'),true);assert.equal(storage.get('screensaver_time'),10);
  assert.equal(storage.get('source'),'cub');
  run({mode:'always',revision:'3',values:{animation:'false'}});
  run({mode:'disabled',revision:'4',values:{}});
  assert.equal(data.has('animation'),false);
});
test('device profiles override global settings on every launch and release back to global',()=>{
  const data=new Map();const storage={get:(k,f)=>data.has(k)?data.get(k):f,set:(k,v)=>data.set(k,v),remove:k=>data.delete(k)};
  const context={Lampa:{Storage:storage},localStorage:{getItem:k=>data.get(k)??null}};context.window=context;
  const run=policy=>vm.runInNewContext(script.replace('POLICY',JSON.stringify(policy)),context);
  storage.set('workspace_device_access',{overrides:{screensaver:'false'}});
  const global={mode:'always',revision:'1',values:{screensaver:'true',source:'cub'}};
  run(global);assert.equal(storage.get('screensaver'),'false');assert.equal(storage.get('source'),'cub');
  run(global);assert.equal(storage.get('screensaver'),'false');
  storage.set('workspace_device_access',{overrides:{}});run(global);assert.equal(storage.get('screensaver'),'true');
  storage.set('workspace_device_access',{overrides:{screensaver:'false'}});run({...global,mode:'disabled'});assert.equal(storage.get('screensaver'),'false');
});
test('menu visibility is rebuilt after a page reload even for an unchanged revision profile',()=>{
  const data=new Map();const storage={get:(k,f)=>data.has(k)?data.get(k):f,set:(k,v)=>data.set(k,v),remove:k=>data.delete(k)};
  let style;
  const document={getElementById:()=>style,createElement:()=>({}),head:{appendChild:node=>style=node}};
  const context={document,Lampa:{Storage:storage},localStorage:{getItem:k=>data.get(k)??null}};context.window=context;
  const source=script.replace('POLICY',JSON.stringify({mode:'revision',revision:'1',values:{workspace_menu_movie:'false'}}));
  vm.runInNewContext(source,context);assert.match(style.textContent,/data-action="movie"/);
  style=null;vm.runInNewContext(source,context);assert.match(style.textContent,/data-action="movie"/);
});

test('settings policy blocks direct navigation and releases sections through inheritance',()=>{
 const data=new Map(),events={},opened=[];
 const storage={get:(k,f)=>data.has(k)?data.get(k):f,set:(k,v)=>data.set(k,v),remove:k=>data.delete(k)};
 const context={Lampa:{Storage:storage,Settings:{create:n=>opened.push(n),listener:{follow:(n,fn)=>events[n]=fn}},Controller:{toggle:n=>opened.push(n)},Noty:{show(){}}},localStorage:{getItem:k=>data.get(k)??null},setTimeout:fn=>fn()};context.window=context;
 const run=values=>vm.runInNewContext(script.replace('POLICY',JSON.stringify({mode:'always',revision:'1',values})),context);
 run({workspace_settings_player:'false',workspace_settings_other:'false'});
 context.Lampa.Settings.create('player');context.Lampa.Settings.create('third_party');assert.deepEqual(opened,[]);
 context.Lampa.Settings.create('interface');assert.deepEqual(opened,['interface']);
 let emptied=false;events.open({name:'player',body:{empty(){emptied=true;}}});assert.equal(emptied,true);
 run({});context.Lampa.Settings.create('player');assert.equal(opened.at(-1),'player');
 run({workspace_settings_all:'false'});const count=opened.length;context.Lampa.Settings.create('workspace_device');assert.equal(opened.length,count);
});
