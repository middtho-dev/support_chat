'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../tools/lampac/ambient.js'),'utf8');
test('ambient background follows theme, full-page navigation, player lifecycle and hidden tabs',()=>{
 const classes=new Set(),events={},playerEvents={},nodes=[];let component='main';
 const document={hidden:false,head:{appendChild:n=>nodes.push(n)},body:{classList:{contains:k=>classes.has(k),toggle:(k,v)=>v?classes.add(k):classes.delete(k)},insertBefore:n=>nodes.push(n)},createElement:()=>({setAttribute(){}}),querySelector:()=>null,addEventListener:(n,f)=>events[n]=f};
 const context={document,setTimeout:f=>f(),Lampa:{Activity:{active:()=>({component})},Listener:{follow:(n,f)=>events[n]=f},Player:{listener:{follow:(n,f)=>playerEvents[n]=f}}}};context.window=context;
 const lampa=context.Lampa;delete context.Lampa;vm.runInNewContext(source,context);events.visibilitychange();context.Lampa=lampa;const api=context.workspaceAmbient,shown=()=>classes.has('workspace-kv9-ambient');
 api.update(true,true);assert.equal(shown(),true);assert.equal(nodes.length,2);
 component='full';events.activity();assert.equal(shown(),false);
 component='category_full';events.activity();assert.equal(shown(),true);
 playerEvents.start();assert.equal(shown(),false);playerEvents.destroy();assert.equal(shown(),true);
 document.hidden=true;events.visibilitychange();assert.equal(shown(),false);document.hidden=false;events.visibilitychange();assert.equal(shown(),true);
 api.update(true,false);assert.equal(shown(),false);api.update(false,true);assert.equal(shown(),false);api.update(true,true);assert.equal(nodes.length,2);
});
