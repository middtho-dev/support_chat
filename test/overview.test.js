'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/js/admin-shell.js'),'utf8');
function setup(fetch){const home={innerHTML:'',addEventListener(){}},rail={innerHTML:''};const ctx={document:{hidden:false,getElementById:()=>home,querySelector:()=>rail,querySelectorAll:()=>[]},fetch,setInterval:()=>1,clearInterval(){},AbortSignal,Date,esc:x=>String(x).replace(/</g,'&lt;'),setView(){}};ctx.window=ctx;vm.runInNewContext(source,ctx);return {shell:ctx.AdminShell,home};}
const settle=()=>new Promise(r=>setImmediate(r));
test('overview isolates service failure and keeps healthy statuses and ticket counts',async()=>{
 const {shell,home}=setup(async url=>{if(url.endsWith('/voice'))throw Error('<offline>');return {ok:true,json:async()=>url.endsWith('/health')?{version:'test',telegram:{configured:true,enabled:true,connected:true},maintenance:{healthy:true}}:{running:true,healthy:true,devices:[],clients:[],torrents:[]}};});
 shell.render({token:'x',view:'home',permissions:{canManageSettings:true},tickets:[{status:'open',unread_count:1}]});await settle();
 assert.match(home.innerHTML,/&lt;offline>/);assert.match(home.innerHTML,/Версия test/);assert.match(home.innerHTML,/TorrServer/);assert.match(home.innerHTML,/Telegram поддержки/);assert.match(home.innerHTML,/Диск и резервные копии/);
});
test('overview does not request manager services for ordinary operators',async()=>{
 const urls=[];const {shell,home}=setup(async url=>{urls.push(url);return {ok:true,json:async()=>({})};});
 shell.render({token:'operator',view:'home',permissions:{canManageSettings:false},tickets:[]});await settle();
 assert.deepEqual(urls,['/api/admin/health']);assert.doesNotMatch(home.innerHTML,/TorrServer/);
});
test('late responses from a previous session cannot repopulate logged-out overview',async()=>{
 let complete;const {shell,home}=setup(()=>new Promise(r=>complete=r));
 shell.render({token:'old',view:'home',permissions:{canManageSettings:false},tickets:[]});
 shell.reset();shell.render({token:null,view:'home',permissions:{canManageSettings:false},tickets:[]});
 complete({ok:true,json:async()=>({version:'private-old'})});await settle();assert.doesNotMatch(home.innerHTML,/private-old/);
});
