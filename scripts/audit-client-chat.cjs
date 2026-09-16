'use strict';
// Run against an isolated local server: no Telegram credentials or production data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium,webkit}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const url=process.env.AUDIT_URL||'http://127.0.0.1:13802/';
if(!['localhost','127.0.0.1'].includes(new URL(url).hostname))throw Error('Local fixture required');
const output=process.env.AUDIT_OUTPUT||'audit-output';fs.mkdirSync(output,{recursive:true});
(async()=>{
 for(const engine of (process.env.AUDIT_ENGINES||'chromium,webkit').split(',')){
  const browser=await ({chromium,webkit}[engine]).launch(engine==='chromium'?{channel:'msedge',headless:true}:{headless:true});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://telegram.org/**',r=>r.abort());
   await page.goto(url);await page.locator('#ni').fill('Проверка интерфейса');
   // Login remains reachable even with a narrow software-keyboard viewport.
   await page.setViewportSize({width:360,height:300});await page.locator('#sb').scrollIntoViewIfNeeded();await page.locator('#sb').click();
   await page.locator('#cs.on').waitFor();
   await page.setViewportSize({width:390,height:844});
   const message='Локальная проверка '+Date.now();
   await page.locator('#ti').fill(message);await page.locator('#sndbtn').click();
   await page.getByText(message,{exact:true}).waitFor();
   await page.reload();await page.getByText(message,{exact:true}).waitFor();
   await page.locator('#ebt').click();assert.ok(await page.locator('#ep').isVisible());await page.locator('#ebt').click();
   await page.locator('#fi').setInputFiles({name:'check.txt',mimeType:'text/plain',buffer:Buffer.from('local fixture')});
   assert.ok(await page.locator('#fp').isVisible());await page.locator('#fp button').click();
   const ticket=await page.evaluate(()=>{socket.disconnect();const id=S.tid;S.tid=null;return id;});
   for(const [width,height] of [[2513,457],[1920,1080],[1366,768],[1089,1272],[390,844],[360,640],[390,340],[844,320]]){
    await page.setViewportSize({width,height});
    await page.evaluate(()=>{renderMsgs([{id:'a',sender:'support',content:'Добро пожаловать в службу поддержки KV9RU!',type:'text',created_at:new Date().toISOString()}]);});
    await page.waitForTimeout(200);
    const state=await page.evaluate(()=>{const rect=id=>document.getElementById(id).getBoundingClientRect().toJSON();return{app:rect('app'),composer:rect('ia'),field:rect('ti'),wrap:rect('mwrap'),first:document.querySelector('#ml .msg').getBoundingClientRect().toJSON(),overflow:document.documentElement.scrollWidth>innerWidth};});
    assert.ok(!state.overflow,`${engine} ${width}: horizontal overflow`);
    assert.ok(state.composer.bottom<=height+1&&state.field.height>20,`${engine} ${width}: composer clipped`);
    assert.ok(state.first.top-state.wrap.top<100,`${engine} ${width}: excessive empty space`);
    assert.ok(state.wrap.height>100,`${engine} ${width}: messages collapsed`);
    await page.locator('#ti').fill('Вопрос\nДополнительная строка\nЕщё одна строка');
    assert.ok(await page.locator('#ti').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
    await page.screenshot({path:path.join(output,`${engine}-${width}x${height}.png`)});
    await page.locator('#ti').fill('');
    await page.locator('#hcl').click();
    await page.locator('.mbox').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
    const box=await page.locator('.mbox').boundingBox();
    assert.ok(box.width<=331&&box.width<=width-39,`${engine} ${width}: dialog too wide`);
    assert.ok(Math.abs(box.x+box.width/2-width/2)<2&&Math.abs(box.y+box.height/2-height/2)<2,'Dialog not centered');
    assert.ok(box.y>=19&&box.y+box.height<=height-19,'Dialog clipped');
    for(const selector of ['.mbc','.mbo'])assert.ok(await page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'Dialog button covered');
    await page.screenshot({path:path.join(output,`${engine}-dialog-${width}x${height}.png`)});
    await page.keyboard.press('Tab');assert.ok(await page.locator('.mbo').evaluate(el=>el===document.activeElement));
    await page.keyboard.press('Escape');assert.equal(await page.locator('.mov').count(),0);
    assert.ok(await page.locator('#hcl').evaluate(el=>el===document.activeElement),'Focus not restored');
   }
   await page.setViewportSize({width:1366,height:768});
   await page.evaluate(()=>{renderMsgs(Array.from({length:80},(_,i)=>({id:String(i),sender:'support',content:'Сообщение '+i,type:'text',created_at:new Date().toISOString()})));scrollBot(false);});
   await page.waitForTimeout(250);
   await page.locator('#mwrap').evaluate(el=>el.scrollTop=0);await page.waitForTimeout(200);
   await page.evaluate(()=>{ml.lastElementChild.style.paddingBottom='100px';});await page.waitForTimeout(200);
   assert.ok(await page.locator('#mwrap').evaluate(el=>el.scrollTop<10),'History jumps on resize');
   // Some embedded browsers briefly report a stale visual viewport after resize.
   await page.evaluate(()=>{Object.defineProperty(window,'visualViewport',{configurable:true,value:{height:1800,offsetTop:0,scale:1}});syncViewport();});
   assert.ok(await page.locator('#ia').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight+1));
   await page.evaluate(id=>{S.tid=id;},ticket);
   await page.locator('#hcl').click();await page.locator('.mbc').click();assert.ok(await page.locator('#ia').isVisible());
   await page.locator('#hcl').click();await page.locator('.mbo').click();await page.locator('#cbar.on').waitFor();
   assert.deepEqual(errors,[]);console.log(engine+': 8 sizes, keyboard-sized login/composer, long history, stale viewport passed');
  }finally{await browser.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
