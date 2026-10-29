// Isolated loopback fixture only. Uses synthetic data; never pass production credentials.
'use strict';
const fs=require('node:fs'),path=require('node:path');const output=process.env.AUDIT_OUTPUT||'/tmp/kv9-workspace-flows';fs.mkdirSync(output,{recursive:true});
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({headless:true,...(process.env.AUDIT_CHROMIUM_PATH?{executablePath:process.env.AUDIT_CHROMIUM_PATH}:{}),args:['--no-sandbox']});
let client,admin;try{
 client=await browser.newPage({viewport:{width:390,height:844}});admin=await browser.newPage({viewport:{width:1440,height:960}});
 for(const p of [client,admin])await p.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await client.goto('http://127.0.0.1:13841/');await client.locator('#ni').fill('Аудит сценария');await client.locator('#sb').click();await client.locator('#cs.on').waitFor();
 const ticket=await client.evaluate(()=>({id:S.tid,token:S.token}));
 await admin.goto('http://127.0.0.1:13841/admin');await admin.locator('#tok').fill('wrong');await admin.locator('#lbtn').click();await admin.locator('#lerr').filter({hasText:'Невер'}).waitFor();
 await admin.locator('#tok').fill('audit-local-only-token');await admin.locator('#lbtn').click();await admin.waitForFunction(id=>S.tickets.some(t=>t.id===id),ticket.id);await admin.evaluate(id=>openTicket(id),ticket.id);
 await admin.locator('#reply-txt').fill('Проверка обычного ответа');await admin.locator('#reply-send').click();await client.getByText('Проверка обычного ответа',{exact:true}).waitFor();
 const proposal=async()=>admin.evaluate(id=>new Promise(resolve=>socket.emit('admin_send_customer_control',{ticketId:id},resolve)),ticket.id);
 assert.equal((await proposal()).ok,true);await client.locator('.close-prompt').waitFor();assert.equal((await proposal()).ok,true);assert.equal(await client.locator('.close-prompt').count(),1);
 await client.locator('#ti').fill('Нужна ещё помощь');await client.locator('#sndbtn').click();await admin.locator('#cv-msgs').getByText('Нужна ещё помощь',{exact:true}).waitFor({timeout:5000});
 await client.locator('.close-prompt[data-state=cancelled]').waitFor();assert.equal(await client.locator('.close-prompt button').count(),0);assert.ok(!(await client.locator('.close-prompt').textContent()).includes('через 5 минут'));await client.reload();await client.locator('.close-prompt[data-state=cancelled]').waitFor();assert.equal(await client.locator('.close-prompt button').count(),0);
 await client.locator('#fi').setInputFiles({name:'audit.txt',mimeType:'text/plain',buffer:Buffer.from('audit-only synthetic attachment')});await client.locator('#sndbtn').click();
 await client.waitForFunction(()=>S._msgs.some(m=>m.file_url));const file=await client.evaluate(()=>S._msgs.find(m=>m.file_url).file_url);
 const anonymous=await browser.newContext();const response=await anonymous.request.get('http://127.0.0.1:13841'+file);assert.equal(response.status(),200);console.log(JSON.stringify({observation:'ATTACHMENT_URL_WITHOUT_AUTH',http:response.status(),requiresKnownRandomUrl:true}));await anonymous.close();

 await admin.evaluate(()=>setView('support-settings'));
 await admin.locator('#set-tg-enabled').waitFor({state:'attached'});
 assert.equal(await admin.locator('#set-close-btn').count(),1);
 for(const id of ['set-tg-pin','set-topic-template','set-tg-rich-entry-effect','set-tg-rich-density','set-tg-rich-group-spacing','set-tg-new-ticket'])assert.equal(await admin.locator('#'+id).count(),0,'Inactive dialog setting is visible: '+id);
 await admin.screenshot({path:path.join(output,'admin-support-settings.png')});
 const deny=await admin.request.get('http://127.0.0.1:13841/api/admin/health');assert.equal(deny.status(),401);
 console.log(JSON.stringify({flows:'wrong login, correct login, real client/operator text exchange, close proposal, repeat protection, continued conversation, upload, API authorization',passed:true}));
 await client.screenshot({path:path.join(output,'client-proposal-after-continue.png')});
}catch(e){console.error(e);for(const [name,p]of [['client',client],['admin',admin]])if(p){await p.screenshot({path:path.join(output,name+'-flow-failure.png')});console.log(name,await p.evaluate(()=>({tid:S.tid,current:S.current?.id,closed:S.closed,pending:S.pendingSend,view:S.view,messages:(S._msgs||S.messages||[]).slice(-4).map(m=>({sender:m.sender,type:m.message_type,content:m.content})),send:document.querySelector('#sndbtn')?.disabled})));}process.exitCode=1;}finally{await browser.close();}})();
