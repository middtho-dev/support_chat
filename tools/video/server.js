'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {Store}=require('./store'),{validate}=require('./config'),{Worker}=require('./worker'),{download}=require('./download');
const {WebhookInbox,registerWebhook}=require('../voice/webhook');
function createService(env=process.env){
 const store=new Store(env.VIDEO_DATA_DIR||'/app/data',env.VIDEO_ENCRYPTION_KEY);
 const publicUrl=new URL(env.VIDEO_PUBLIC_URL).origin;
 if(!publicUrl.startsWith('https://')||!env.VIDEO_SERVICE_TOKEN)throw Error('Configure HTTPS public URL and service token');
 if(!/^[A-Za-z0-9_-]{32,256}$/.test(env.VIDEO_WEBHOOK_SECRET||''))throw Error('Configure VIDEO_WEBHOOK_SECRET');
 let inbox,registered='',error='',connecting=false,secret='';
 const call=async(method,data)=>{
  let response;try{response=await fetch('https://api.telegram.org/bot'+store.data.config.botToken+'/'+method,{method:'POST',redirect:'error',...(data instanceof FormData?{body:data}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),signal:AbortSignal.timeout(['sendVideo','answerGuestQuery'].includes(method)?90000:10000)});}catch{throw Error('Telegram не подтвердил ответ. Автоматический повтор отключён.');}
  const body=await response.json();if(!body.ok){const e=Error('Telegram: '+String(body.description||response.status).slice(0,250));e.definite=true;throw e;}return body.result;
 };
 const worker=new Worker(store,{call,download,publicUrl});
 function prepare(){
  inbox?.stop();registered='';
  const token=store.data.config.botToken;if(!token)return;
  const namespace=crypto.createHash('sha256').update(token).digest('hex').slice(0,20);
  secret=crypto.createHmac('sha256',env.VIDEO_WEBHOOK_SECRET).update(token).digest('hex');
  inbox=new WebhookInbox({dir:path.join(store.dir,'inbox',namespace),secret,handle:u=>worker.accept(u),ready:()=>!!registered&&store.data.config.enabled});
 }
 async function connect(){
  if(connecting||!store.data.config.botToken)return;
  connecting=true;
  try{worker.bot=await call('getMe',{});if(store.data.config.enabled){await registerWebhook(call,publicUrl+'/api/webhooks/telegram/video',secret,['guest_message','message']);registered=store.data.config.botToken;}error='';}
  catch(e){error=e.message;throw e;}finally{connecting=false;}
 }
 function status(){const {botToken,...config}=store.data.config;return {config,hasBotToken:!!botToken,bot:worker.bot?{username:worker.bot.username,guestMode:!!worker.bot.supports_guest_queries}:null,error,busy:worker.busy,transport:inbox?.status()||null,jobs:store.data.jobs.slice(-30).reverse().map(({id,user,source,title,status,error,created,finished,size})=>({id,user,source,title,status,error,created,finished,size}))};}
 const json=(res,code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const server=http.createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(pathname==='/health')return json(res,200,{ok:true});
   if(pathname==='/api/webhooks/telegram/video'){if(!inbox)return json(res,503,{error:'Не настроен'});return inbox.receive(req,res);}
   const file=pathname.match(/^\/api\/video\/files\/(\d+)\/([a-f0-9]{64})\.(mp4|jpg)$/);
   if(file&&['GET','HEAD'].includes(req.method)){
    const job=store.data.jobs.find(j=>j.id===file[1]&&j.cap===file[2]&&j.expires>Date.now());if(!job)return json(res,404,{});
    const target=path.join(store.dir,'files',job.id,file[3]==='jpg'?'thumbnail.jpg':'video.mp4'),size=fs.statSync(target).size;let start=0,end=size-1,code=200;
    if(req.headers.range){const r=req.headers.range.match(/^bytes=(\d+)-(\d*)$/);if(!r)return json(res,416,{});start=Number(r[1]);end=r[2]?Math.min(Number(r[2]),end):end;if(start>end||start>=size)return json(res,416,{});code=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);}
    res.writeHead(code,{'Content-Type':file[3]==='jpg'?'image/jpeg':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});if(req.method==='HEAD')return res.end();const stream=fs.createReadStream(target,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
   }
   const supplied=Buffer.from(String(req.headers['x-admin-token']||'')),expected=Buffer.from(env.VIDEO_SERVICE_TOKEN);
   if(supplied.length!==expected.length||!crypto.timingSafeEqual(supplied,expected))return json(res,401,{error:'Требуется вход'});
   if(pathname==='/api/video'&&req.method==='GET')return json(res,200,status());
   if(req.method!=='POST'||!['/api/video/configure','/api/video/check'].includes(pathname))return json(res,404,{});
   if(worker.busy||connecting)return json(res,409,{error:'Дождитесь завершения текущего запроса'});
   if(pathname.endsWith('/check')){await connect();return json(res,200,status());}
   const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>16384)return json(res,413,{});chunks.push(b);}
   if(worker.busy||connecting)return json(res,409,{error:'Дождитесь завершения текущего запроса'});
   const next=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')),store.data.config);
   if(next.botToken!==store.data.config.botToken&&store.data.jobs.some(j=>['queued','downloading','sending'].includes(j.status)))return json(res,409,{error:'Перед сменой бота дождитесь опустошения очереди'});
   if(next.botToken!==store.data.config.botToken){for(const job of store.data.jobs)await fs.promises.rm(path.join(store.dir,'files',job.id),{recursive:true,force:true});store.data.jobs=[];worker.bot=null;}
   store.data.config=next;store.save();prepare();
   if(next.enabled)await connect();return json(res,200,status());
  }catch(e){if(!res.headersSent)json(res,400,{error:e.message||'Ошибка запроса'});else res.destroy();}
 });
 prepare();
 const timer=setInterval(()=>{if(store.data.config.enabled&&!registered)connect().catch(()=>{});if(registered)worker.tick().catch(()=>{error='Ошибка хранилища заданий';});},3000);
 const cleanup=setInterval(()=>worker.cleanup().catch(()=>{error='Не удалось удалить временные файлы';}),60000);
 server.on('close',()=>{clearInterval(timer);clearInterval(cleanup);inbox?.stop();});
 return {server,store,worker};
}
if(require.main===module)createService().server.listen(Number(process.env.VIDEO_PORT)||7800,'127.0.0.1');
module.exports={createService};
