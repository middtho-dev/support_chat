'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {render}=require('../rich'),{validate}=require('../config'),{Store}=require('../store'),{Worker}=require('../worker'),{createServer}=require('../server');
test('readable defaults and safe structured rich formatting',()=>{
 assert.equal(render('Text').html,'<p>Text</p>');
 const value=render('Title\n<script>bad</script>\n\nSecond',{prefix:'Title',richBold:true,richHighlight:true,richCollapse:true,richSummary:'<summary>',richFooter:'<img src=x>',richDivider:true,richAutoLinks:false,richRtl:true});
 assert.match(value.html,/<p><b>Title<\/b><\/p><hr><details>/);assert.match(value.html,/&lt;script&gt;/);assert.match(value.html,/<mark><b>/);assert.match(value.html,/&lt;img src=x&gt;/);assert.equal(value.skip_entity_detection,true);assert.equal(value.is_rtl,true);
 assert.throws(()=>validate({richBody:'script'}));assert.throws(()=>validate({richTitleStyle:'h7'}));assert.throws(()=>validate({richUpdateMs:10}));assert.throws(()=>validate({richChunkChars:99999}));
});
test('monospace, headings, quotes and explicit muted footers are supported',()=>{
 assert.equal(render('a\nb',{richBody:'pre',richBold:true}).html,'<pre>a\nb</pre>');
 assert.equal(render('T\nBody',{prefix:'T',richTitleStyle:'hidden',richBody:'quote'}).html,'<blockquote><p>Body</p></blockquote>');
 assert.match(render('Text',{richBody:'h6'}).html,/^<h6>/);assert.match(render('Text',{richBody:'footer'}).html,/^<footer>/);
});
test('old compact setting migrates to normal contrast without resetting explicit new settings',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rich-migration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let store=new Store(dir,'a'.repeat(64));store.data.config.richCompact=true;delete store.data.config.richBody;store.save();store=new Store(dir,'a'.repeat(64));assert.equal(store.data.config.richBody,'paragraph');assert.equal(store.data.config.richCompact,undefined);store.data.config.richBody='quote';store.save();assert.equal(new Store(dir,'a'.repeat(64)).data.config.richBody,'quote');
});
test('authenticated rich preview is local and live style changes preserve bot credentials and enable state',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rich-server-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const store=new Store(dir,'a'.repeat(64));Object.assign(store.data.config,{enabled:true,botToken:'123:'+ 'b'.repeat(25),openaiKey:'test',ownerIds:'1'});
 const worker=new Worker(store,{telegram:async()=>{throw Error('Must not contact Telegram');},polish:async()=>{throw Error('Must not contact AI');}});worker.busy=true;
 const server=createServer(store,worker,'test-admin');await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const send=(suffix,data,auth=true)=>fetch(base+'/api/voice/'+suffix,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'x-admin-token':'test-admin'}:{})},body:JSON.stringify(data)});
 assert.equal((await send('rich-preview',{text:'Hello'},false)).status,401);
 const preview=await send('rich-preview',{text:'Hello',settings:{richBold:true}});assert.equal(preview.status,200);assert.match((await preview.json()).rich.html,/<b>Hello<\/b>/);assert.equal(store.data.config.richBold,false);
 assert.equal((await send('rich-configure',{richBold:true,richProtect:true})).status,200);assert.equal(store.data.config.richBold,true);assert.equal(store.data.config.enabled,true);assert.equal(store.data.config.openaiKey,'test');
 assert.equal((await send('rich-configure',{richBody:'script'})).status,400);assert.equal(store.data.config.richBody,'paragraph');
});
