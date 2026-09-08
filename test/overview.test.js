'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../public/js/admin-shell.js'),'utf8');
function setup(fetch){
 const nodes=new Map(),events={},intervals=new Map();let serial=0,mounts=0,markup='';
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',className:'',setAttribute(){}});return nodes.get(id);};
 const button=node('refresh');
 const home={get innerHTML(){return markup;},set innerHTML(v){markup=v;mounts++;nodes.clear();},addEventListener(){},querySelector(){return button;}},rail={innerHTML:''};
 const document={hidden:false,addEventListener(name,fn){events[name]=fn;},getElementById:id=>id==='home'?home:node(id),querySelector:()=>rail,querySelectorAll:()=>[]};
 const ctx={document,fetch,setInterval(fn){intervals.set(++serial,fn);return serial;},clearInterval(id){intervals.delete(id);},AbortSignal,AbortController,Date,esc:x=>String(x).replace(/</g,'&lt;'),setView(){},addEventListener(name,fn){events[name]=fn;}};ctx.window=ctx;vm.runInNewContext(source,ctx);
 return {shell:ctx.AdminShell,home,node,events,document,tick:()=>[...intervals.values()].forEach(fn=>fn()),text:()=>markup+[...nodes.values()].map(n=>n.textContent+n.innerHTML).join(' '),mounts:()=>mounts};
}
const settle=()=>new Promise(r=>setImmediate(r));
const state=(token='manager',manager=true)=>({token,view:'home',permissions:{canManageSettings:manager},tickets:[{status:'open',unread_count:1}]});
const response=data=>({ok:true,json:async()=>data});
test('overview isolates service failure and renders service and ticket counts',async()=>{
 const h=setup(async url=>{if(url.endsWith('/voice'))throw Error('<offline>');return response(url.endsWith('/health')?{version:'test',telegram:{configured:true,enabled:true,connected:true},maintenance:{healthy:true}}:{running:true,healthy:true,devices:[],clients:[],torrents:[]});});
 h.shell.render(state());await settle();assert.match(h.text(),/&lt;offline>/);assert.match(h.text(),/Версия test/);assert.match(h.text(),/TorrServer/);assert.equal(h.node('overview-open').textContent,1);
});
test('overview requests only health for ordinary operators',async()=>{
 const urls=[];const h=setup(async url=>{urls.push(url);return response({});});h.shell.render(state('operator',false));await settle();assert.deepEqual(urls,['/api/admin/health']);assert.doesNotMatch(h.text(),/TorrServer/);
});
test('automatic refresh updates values without remounting dashboard or buttons',async()=>{
 let version=0;const h=setup(async()=>response({version:++version}));const s=state('x',false);h.shell.render(s);await settle();const mounts=h.mounts();h.tick();await settle();assert.match(h.text(),/Версия 2/);assert.equal(h.mounts(),mounts);h.shell.render(s);assert.equal(h.mounts(),mounts);
});
test('failed refresh retains last successful values and marks them stale',async()=>{
 let fail=false;const h=setup(async()=>{if(fail)throw Error('offline');return response({version:'retained',telegram:{configured:true}});});h.shell.render(state('x',false));await settle();fail=true;h.tick();await settle();assert.match(h.text(),/Версия retained/);assert.match(h.text(),/Данные устарели/);assert.ok(h.node('overview-issues').textContent>0);
});
test('hidden page aborts requests and refreshes immediately on return',async()=>{
 let calls=0,signal;const h=setup(async(u,o)=>{calls++;signal=o.signal;return response({});});h.shell.render(state('x',false));await settle();h.document.hidden=true;h.events.visibilitychange();const previous=calls;h.tick();assert.equal(calls,previous);h.document.hidden=false;h.events.visibilitychange();await settle();assert.equal(calls,previous+1);assert.equal(signal.aborted,false);
});
test('slow polls never overlap and leaving overview aborts pending request',async()=>{
 let calls=0,signal;const h=setup((u,o)=>{calls++;signal=o.signal;return new Promise(()=>{});});const s=state('x',false);h.shell.render(s);h.tick();h.tick();assert.equal(calls,1);s.view='templates';h.shell.render(s);assert.equal(signal.aborted,true);h.tick();assert.equal(calls,1);
});
test('late responses from a previous session cannot repopulate logged-out overview',async()=>{
 let complete;const h=setup(()=>new Promise(r=>complete=r));h.shell.render(state('old',false));h.shell.reset();h.shell.render(state(null,false));complete(response({version:'private-old'}));await settle();assert.doesNotMatch(h.text(),/private-old/);assert.equal(h.home.innerHTML,'');
});
