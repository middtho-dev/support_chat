'use strict';
// Real device-panel DOM and handlers; all registrations/deletions use this local fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http'),os=require('node:os');
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),output=process.env.AUDIT_OUTPUT||fs.mkdtempSync(path.join(os.tmpdir(),'lampac-devices-audit-'));
fs.mkdirSync(output,{recursive:true});
const device=id=>({id,name:'Устройство '+id,enabled:1,last:Math.floor(Date.now()/1000),ip:'192.0.2.1',applied:1,revision:1,desired:{theme:'true'},snapshot:{}});
const fields=[{key:'theme',label:'Тема интерфейса',group:'Оформление',description:'Настройка тестового устройства',options:{true:'Включено',false:'Выключено'}}];
let devices=[],defer=false,release=null,started=null;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/api/devices'){
  res.setHeader('Content-Type','application/json');
  if(req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;const action=JSON.parse(body);
   if(action.action==='revoke')devices=devices.filter(d=>d.id!==action.id);
   res.end('{}');return;
  }
  const snapshot=JSON.stringify({devices,fields,shared:{}});
  if(defer){defer=false;started?.();await new Promise(r=>{release=r;});}
  res.end(snapshot);return;
 }
 if(url.pathname==='/api/playback'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({devices,sessions:[],serverTime:Math.floor(Date.now()/1000)}));return;}
 if(url.pathname==='/panel'){
  res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/admin.css"><link rel="stylesheet" href="/css/admin-shell.css"><link rel="stylesheet" href="/css/admin-lampac.css"><link rel="stylesheet" href="/css/workspace-theme.css"><link rel="stylesheet" href="/css/design-tokens.css"><div id="app" style="display:block;height:100%"><section class="panel on" id="lampac"><div class="section voice-section"><div class="page-heading"><h2>Lampac</h2><p>Устройства</p></div><div class="card">Стенд</div></div></section></div><script>window.esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));</script><script src="/js/admin-lampac-advanced.js"></script><script>window.panel=mountLampacAdvanced({container:document.getElementById('lampac'),publicUrl:'https://example.test',toggle:(id,label,checked)=>'<label>'+esc(label)+'<input type="checkbox" id="lc-'+id+'" '+(checked?'checked':'')+'></label>',request:async suffix=>{const r=await fetch('/api'+suffix);return r.json();},operation:async(suffix,body)=>{await fetch('/api'+suffix,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return true;}});</script>`);return;
 }
 const file=path.join(root,'public',url.pathname);if(!file.startsWith(root+'/public/')){res.writeHead(403).end();return;}
 fs.readFile(file,(e,body)=>{if(e){res.writeHead(404).end();return;}res.setHeader('Content-Type',path.extname(file)==='.js'?'application/javascript':'text/css');res.end(body);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{for(const[name,engine]of[['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true,...(name==='chromium'?{...(process.env.AUDIT_CHROMIUM_PATH?{executablePath:process.env.AUDIT_CHROMIUM_PATH}:{}),args:process.getuid?.()===0?['--no-sandbox']:[]}:{})});
  try{for(const width of [360,390,1440]){
   devices=[device('A'),device('B')];defer=false;release=null;
   const page=await browser.newPage({viewport:{width,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
   await page.goto('http://127.0.0.1:'+server.address().port+'/panel');
   await page.getByRole('button',{name:'Устройства',exact:true}).click();
   const card=id=>page.locator('[data-record-key="'+id+'"]');
   await card('A').waitFor();await card('A').locator(':scope > summary').click();
   const nameInput=card('A').locator('input[name=deviceName]');await nameInput.fill('Несохранённое название');
   await card('A').locator('.lc-device-settings > summary').click();
   await card('A').locator('.lc-pref-family > summary').click();
   await card('A').locator('.lc-pref-group > summary').click();
   await card('A').locator('[data-managed]').uncheck();
   await nameInput.focus();await nameInput.evaluate(e=>{window.editedInput=e;e.setSelectionRange(4,8);});
   devices.push(device('C'));
   await page.evaluate(()=>panel.refresh());await card('C').waitFor();
   assert.equal(await nameInput.inputValue(),'Несохранённое название');
   assert.ok(await nameInput.evaluate(e=>e===window.editedInput&&e===document.activeElement&&e.selectionStart===4&&e.selectionEnd===8),'Background registration lost focus/caret');
   assert.ok(await card('A').evaluate(e=>e.open&&e.querySelector('.lc-device-settings').open),'Expanded groups closed');
   assert.equal(await card('A').locator('[data-managed]').isChecked(),false,'Draft profile reset');
   // Return B's old snapshot after deleting B; the action must queue another fetch.
   defer=true;const waiting=new Promise(r=>{started=r;});await page.evaluate(()=>{panel.refresh();});await waiting;
   await card('B').locator(':scope > summary').click();page.once('dialog',d=>d.accept());await card('B').getByRole('button',{name:'Удалить устройство',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('[data-record-key="B"]')!==null);
   // Wait for the POST to change fixture state before releasing the stale GET.
   const deadline=Date.now()+5000;while(devices.some(d=>d.id==='B')){if(Date.now()>deadline)throw Error('Deletion POST never reached fixture');await new Promise(r=>setTimeout(r,10));}
   release();release=null;await page.waitForFunction(()=>!document.querySelector('[data-record-key="B"]'));
   assert.equal(await nameInput.inputValue(),'Несохранённое название');
   // A new index for C must still remove C, never the retained A card.
   await card('C').locator(':scope > summary').click();page.once('dialog',d=>d.accept());await card('C').getByRole('button',{name:'Удалить устройство',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[data-record-key="C"]'));
   assert.ok(await card('A').count());assert.equal(await nameInput.inputValue(),'Несохранённое название');
   await page.screenshot({path:path.join(output,`${name}-${width}-devices.png`)});
   devices=[];await page.evaluate(()=>panel.refresh());await page.getByText('Запустите Lampa с плагином Workspace: устройство появится автоматически.',{exact:true}).waitFor();
   assert.equal(await page.locator('[data-record-key]').count(),0);assert.deepEqual(errors,[]);await page.close();
   console.log(name+' '+width+': registration, concurrent deletion, stable IDs, draft/focus/caret, expanded settings and empty list passed');
  }}finally{release?.();await browser.close();}
 }}finally{await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
