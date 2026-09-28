'use strict';
// Local CSS fixture: the item touches all four edges of an overflow:hidden parent.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const moduleName=process.env.PLAYWRIGHT_MODULE||'playwright';
const {chromium,webkit}=require(moduleName);
const {PNG}=require(require.resolve('pngjs',{paths:[path.dirname(require.resolve(moduleName))]}));
const root=path.resolve(__dirname,'..'),output=process.env.AUDIT_OUTPUT||'audit-focus-output';
fs.mkdirSync(output,{recursive:true});
const source=fs.readFileSync(path.join(root,'tools/lampac/client-profile.js'),'utf8').replace('POLICY',JSON.stringify({mode:'disabled',values:{}}));
const native=process.env.AUDIT_LAMPA_CSS?fs.readFileSync(process.env.AUDIT_LAMPA_CSS,'utf8'):'.ring-host::after{content:"";position:absolute;inset:-.5em;border:.3em solid white;z-index:-1}';
const cases=[['card','card__view'],['card-episode','full-episode'],['card-more','card-more__box'],...['register','card-parser','full-review-add','full-episode','torrent-item','explorer-card__head-img','season-info','season-episode','watched-history','extensions__block-empty','extensions__block-add','extensions__item'].map(x=>[x]),...['menu__item','settings-param','selectbox-item','simple-button','torrent-file','torrent-serial','head__action'].map(x=>[x])];
function checkPixels(buffer,rect,label){
 const png=PNG.sync.read(buffer),points=[[rect.x+2,rect.y+rect.height/2],[rect.x+rect.width-2,rect.y+rect.height/2],[rect.x+rect.width/2,rect.y+2],[rect.x+rect.width/2,rect.y+rect.height-2]];
 for(const [x,y]of points){const i=(Math.floor(y)*png.width+Math.floor(x))*4;assert.ok(Math.abs(png.data[i]-187)<12&&Math.abs(png.data[i+1]-249)<12&&Math.abs(png.data[i+2]-112)<12,label+' missing edge at '+x+','+y+': '+[...png.data.slice(i,i+3)]);}
}
(async()=>{let checks=0;
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{channel:'msedge',headless:true}:{headless:true});
  try{const page=await browser.newPage();await page.route('**/*',r=>r.abort());
   for(const width of [390,1440])for(const state of ['focus','hover']){
    await page.setViewportSize({width,height:1500});
    const html=cases.map(([parent,child])=>`<section><p>${parent}</p><div class="clip">${child?`<div class="${parent} ${state} fixture-parent"><div class="${child} ring-host"><div class="poster"></div></div></div>`:`<div class="${parent} ${state} ring-host">Выбор</div>`}</div></section>`).join('');
    await page.setContent(`<style>${native}</style><style>html{font-size:20px}body{margin:0;padding:10px;background:#101214;color:white;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}section{min-width:0}p{font:12px sans-serif;margin:0 0 4px}.clip{overflow:hidden;height:90px;width:100%;border-radius:13px}.fixture-parent,.ring-host{position:relative!important;width:100%!important;height:100%!important;max-width:none!important;min-height:0!important;min-width:0!important;padding:0!important;margin:0!important;box-sizing:border-box!important;float:none!important;display:block!important;font-size:20px!important;border:0!important;border-radius:13px!important}.poster{position:absolute;inset:0;background:#454545;z-index:1}.ring-host{background:#222629}</style>${html}`);
    await page.evaluate(()=>{const data=new Map();window.Lampa={Storage:{get:(k,f)=>data.has(k)?data.get(k):f,set:(k,v)=>data.set(k,v),remove:k=>data.delete(k)}};});
    await page.addScriptTag({content:source});await page.evaluate(()=>workspaceApplyTheme(true));
    await page.waitForTimeout(400);
    const buffer=await page.screenshot({path:path.join(output,`${name}-${width}-${state}.png`),fullPage:true});
    const rects=await page.locator('.ring-host').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
    rects.forEach((rect,i)=>{checkPixels(buffer,rect,`${name} ${width} ${state} ${cases[i][0]}`);checks+=4;});
    await page.evaluate(()=>workspaceApplyTheme(false));assert.equal(await page.locator('#workspace-menu-visibility').textContent(),'');
   }

   const webCSS=['admin.css','admin-shell.css','workspace-theme.css','admin-editor.css','design-tokens.css'].map(f=>fs.readFileSync(path.join(root,'public/css',f),'utf8')).join('\n')+fs.readFileSync(path.join(root,'tools/frp/public/panel.css'),'utf8');
   for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    await page.setContent(`<style>${webCSS}</style><style>body{display:block!important;height:auto!important;overflow:auto!important;padding:12px}.clip{overflow:hidden;width:100%;height:44px;margin:12px 0}.clip>button,.clip>summary,.clip>a{display:block;width:100%;height:44px;margin:0}.voice-switch{display:block}.editor-switch{margin:0}input{width:100%}</style><div class="clip"><button class="navbtn">Раздел</button></div><div class="clip"><button class="save">Сохранить</button></div><details class="clip"><summary>Настройки</summary></details><div class="clip"><a href="#">Открыть</a></div><div class="clip"><input aria-label="Имя"></div><div id="frp"><div class="clip"><input aria-label="Адрес"></div></div><label class="voice-switch"><input type="checkbox"><span class="voice-switch-track"></span></label><label class="editor-switch"><input type="checkbox" role="switch"></label>`);
    const controls=page.locator('button,summary,a,input');
    for(let i=0;i<await controls.count();i++){
     const control=controls.nth(i),before=await control.boundingBox();await control.focus();
     const state=await control.evaluate(n=>{const target=n.closest('.voice-switch')?.querySelector('.voice-switch-track')||n,s=getComputedStyle(target);return {outline:s.outlineStyle,width:parseFloat(s.outlineWidth),offset:parseFloat(s.outlineOffset),shadow:s.boxShadow};});
     assert.deepEqual(await control.boundingBox(),before,name+' focus changes layout');
     if(state.outline!=='none')assert.ok(state.offset+state.width<=0,JSON.stringify(state));
     if(state.shadow!=='none')assert.ok(state.shadow.includes('inset'),JSON.stringify(state));
     checks++;
    }
    await page.screenshot({path:path.join(output,`${name}-${width}-workspace.png`),fullPage:true});
   }
  }finally{await browser.close();}
 }
 console.log(checks+' edge-pixel and workspace focus checks passed in Chromium and WebKit');
})().catch(error=>{console.error(error);process.exitCode=1});
