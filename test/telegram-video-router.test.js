'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {isVideoUpdate,createVideoRouter}=require('../src/telegram-video-router');
test('shared bot leaves ordinary support messages and links alone',()=>{
 const msg=text=>({message:{text,chat:{id:1,type:'private'},message_thread_id:12}});
 for(const text of ['Помогите с роутером','https://youtube.com/shorts/abcdefghijk','/start','/close','/video@otherbot ссылка','@helpbot_other https://youtube.com/shorts/abcdefghijk'])assert.equal(isVideoUpdate(msg(text),'helpbot'),false,text);
 for(const text of ['/video ссылка','/video@helpbot ссылка','@helpbot https://youtube.com/shorts/abcdefghijk'])assert.equal(isVideoUpdate(msg(text),'helpbot'),true,text);
 assert.equal(isVideoUpdate({message:{text:'@helpbot',reply_to_message:{text:'https://instagram.com/reel/abc'}}},'helpbot'),true);
 assert.equal(isVideoUpdate({guest_message:{guest_query_id:'q'}},'helpbot'),true);
});
test('video handoff persists before acknowledging and survives service outage',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-router-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let calls=0;
 const router=createVideoRouter({dir,token:'private-service',fetchImpl:async()=>{calls++;return {ok:false};}});
 router.route({update_id:101,guest_message:{guest_query_id:'q'}},'helpbot');assert.equal(router.status().pending,1);await router.flush();router.stop();assert.equal(calls,1);assert.equal(router.status().pending,1);
 const record=JSON.parse(fs.readFileSync(path.join(dir,'101.json')));record.next=0;fs.writeFileSync(path.join(dir,'101.json'),JSON.stringify(record));
 const restored=createVideoRouter({dir,token:'private-service',fetchImpl:async(url,options)=>{assert.equal(new URL(url).pathname,'/api/video/update');assert.equal(JSON.parse(options.body).update_id,101);return {ok:true};}});
 restored.route({update_id:101,guest_message:{guest_query_id:'q'}},'helpbot');await restored.flush();restored.stop();assert.equal(restored.status().pending,0);
});
test('shared service never registers another webhook or exposes primary token',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-shared-'));const original=global.fetch,calls=[];
 global.fetch=async(url)=>{calls.push(String(url).split('/').pop());return {json:async()=>({ok:true,result:{id:1,username:'helpbot',supports_guest_queries:true}})};};
 const {createService}=require('../tools/video/server');const svc=createService({VIDEO_DATA_DIR:dir,VIDEO_ENCRYPTION_KEY:'a'.repeat(64),VIDEO_SERVICE_TOKEN:'secret-service',VIDEO_WEBHOOK_SECRET:'s'.repeat(32),VIDEO_MAIN_BOT_TOKEN:'123:'+'x'.repeat(25),VIDEO_PUBLIC_URL:'https://example.com'});
 await new Promise(r=>svc.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{global.fetch=original;await new Promise(r=>svc.server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+svc.server.address().port,headers={'x-admin-token':'secret-service','Content-Type':'application/json'};
 const r=await original(base+'/api/video/configure',{method:'POST',headers,body:JSON.stringify({enabled:true})});assert.equal(r.status,200);const d=await r.json();assert.equal(d.sharedBot,true);assert.equal(d.config.botToken,undefined);assert.equal(d.bot.guestMode,true);assert.deepEqual(calls,['getMe']);
 assert.equal((await original(base+'/api/video/update',{method:'POST',body:'{}'})).status,401);
 assert.equal((await original(base+'/api/webhooks/telegram/video',{method:'POST'})).status,404);
 assert.ok(!fs.readFileSync(path.join(dir,'state.json'),'utf8').includes('x'.repeat(25)));
});
test('paused support does not block video updates in the same chat',async t=>{
 const {WebhookInbox}=require('../tools/voice/webhook');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-partitions-')),seen=[];
 const inbox=new WebhookInbox({dir,secret:'a'.repeat(32),partition:u=>isVideoUpdate(u,'helpbot')?'video':'support',handle:async u=>{if(!isVideoUpdate(u,'helpbot'))throw Error('Support paused');seen.push(u.update_id);}});
 t.after(()=>{inbox.stop();fs.rmSync(dir,{recursive:true,force:true});});
 inbox.accept({update_id:1,message:{chat:{id:5},text:'Support request'}});inbox.accept({update_id:2,message:{chat:{id:5},text:'/video https://youtu.be/abcdefghijk'}});
 await inbox.drain();assert.deepEqual(seen,[2]);assert.equal(inbox.status().pending,1);
});
