'use strict';
// Read-only UI audit. Use an isolated fixture server; never pass production here.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const url=process.env.AUDIT_URL||'http://127.0.0.1:13001/admin';
if(!['127.0.0.1','localhost'].includes(new URL(url).hostname))throw Error('Use a local isolated fixture server');
const output=process.env.AUDIT_OUTPUT||'audit-output';fs.mkdirSync(output,{recursive:true});
const inventory=[],results=[];
(async()=>{for(const[engine,type]of[['chromium',chromium],['webkit',webkit]]){
 const browser=await type.launch(engine==='chromium'?{channel:'msedge',headless:true}:{headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.getByLabel('Ключ доступа',{exact:true}).fill(process.env.AUDIT_TOKEN||'local-unified-admin-token');await page.getByRole('button',{name:'Войти',exact:true}).click();
 for(const width of [1440,820,390,360,2548]){
  await page.setViewportSize({width,height:960});await page.evaluate(w=>{document.body.classList.toggle('tg-mini',w<1000);document.documentElement.style.setProperty('--tg-top-ui',w<1000?'84px':'0px');document.documentElement.style.setProperty('--tg-bottom-ui','20px');},width);
  for(const view of ['home','chat','frp','voice','lampac','settings']){
   await page.locator(`.navbtn[data-view=${view}]`).click();await page.waitForTimeout(160);
   const nav=page.locator(view==='chat'?'#support-nav':`#${view}-subnav`);
   const labels=await nav.count()?await nav.locator('button').allTextContents():[];
   for(const label of labels.length?labels:['Обзор']){
    if(labels.length){const button=nav.getByRole('button',{name:label,exact:true});await button.scrollIntoViewIfNeeded();const hit=await button.evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));});assert.ok(hit,engine+' '+width+' '+view+' '+label+' is covered');await button.click();await page.waitForTimeout(120);assert.ok(await button.evaluate(el=>el.classList.contains('on')),label+' active state');if(width<=560)assert.equal(await nav.evaluate(el=>el.parentElement.tagName),'BODY');}
    const section=view==='chat'?null:page.locator('#'+view);
    if(section&&view==='frp')assert.equal(await section.locator('.frp-tabs button[aria-pressed=true]').count(),1);
    await page.locator('.panel.on details').evaluateAll(nodes=>nodes.forEach(node=>node.open=true));await page.waitForTimeout(60);
    const state=await page.evaluate(()=>{const panel=document.querySelector('.panel.on');if(!panel)return{overflow:false,controls:[]};const rect=panel.getBoundingClientRect();const controls=[...panel.querySelectorAll('button,input,textarea,select,summary')].map(el=>{const r=el.getBoundingClientRect();return{id:el.id,label:(el.getAttribute('aria-label')||el.closest('label')?.textContent||el.textContent||el.getAttribute('placeholder')||'').replace(/\s+/g,' ').trim().slice(0,180),type:el.type||el.tagName.toLowerCase(),disabled:!!el.disabled,visible:r.width>0&&r.height>0};});return{overflow:panel.scrollWidth>panel.clientWidth+2,top:rect.top,controls};});
    assert.ok(!state.overflow,engine+' '+width+' '+view+' '+label+' overflow');
    if(engine==='webkit'&&width===390)inventory.push({view,tab:label,controls:state.controls});
    results.push({engine,width,view,tab:label,passed:true});
    if((width===390||width===1440)&&engine==='webkit'){await page.locator('.panel.on').evaluateAll(nodes=>nodes.forEach(n=>n.scrollTop=0));await page.screenshot({path:path.join(output,`${engine}-${width}-${view}-${labels.indexOf(label)}.png`)});}
   }
  }
 }
 assert.deepEqual(errors,[]);await browser.close();}
 fs.writeFileSync(path.join(output,'inventory.json'),JSON.stringify(inventory,null,2));fs.writeFileSync(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(results.length+' navigation/layout checks passed; '+inventory.reduce((n,x)=>n+x.controls.length,0)+' controls inventoried');
})().catch(error=>{console.error(error);process.exit(1)});
