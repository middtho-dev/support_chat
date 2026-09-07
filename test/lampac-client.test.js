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
