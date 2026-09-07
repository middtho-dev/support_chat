'use strict';
const http=require('http'),crypto=require('crypto');
const {Store}=require('./store'),{Worker}=require('./worker'),{validate}=require('./config');
function createServer(store,worker,token){
  const vpn=worker.adapters.vpn;let configuring=false,previewing=false;
  return http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
    const send=(code,value)=>{res.writeHead(code);res.end(JSON.stringify(value));};
    if(req.url==='/health')return send(200,{ok:true});
    const supplied=Buffer.from(String(req.headers['x-admin-token']||'')),expected=Buffer.from(token);
    if(!expected.length||expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))return send(401,{error:'Требуется авторизация'});
    const status=()=>({...store.status(),busy:worker.busy,error:worker.error,vpn:vpn?.status()||{running:false}});
    if(req.method==='GET'&&req.url==='/api/voice')return send(200,status());
    if(req.method!=='POST'||!['/api/voice/configure','/api/voice/check','/api/voice/check-vpn','/api/voice/preview'].includes(req.url))return send(404,{error:'Неизвестный запрос'});
    let ownsLock=false;
    try{
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return send(413,{error:'Слишком большой запрос'});}
      const input=JSON.parse(body||'{}');
      if(req.url.endsWith('/preview')){
        if(previewing||configuring)throw Error('Дождитесь завершения текущей проверки');
        if(typeof input.text!=='string'||!input.text.trim()||input.text.length>3000)throw Error('Введите пример текста длиной до 3000 символов');
        const keys=[...Object.keys(require('./formatting').formatDefaults),'polish','emoji','style','instructions','formatModel'];
        const settings=Object.fromEntries(keys.filter(k=>Object.hasOwn(input.settings||{},k)).map(k=>[k,input.settings[k]]));
        const c=validate(settings,store.data.config);
        if((c.polish||c.emoji)&&!c.openaiKey)throw Error('Сначала сохраните ключ OpenAI');
        previewing=true;const start=Date.now();
        try{return send(200,{text:await worker.polish(input.text,c,25000),elapsedMs:Date.now()-start,model:c.polish||c.emoji?c.formatModel:null});}
        finally{previewing=false;}
      }
      if(req.url.endsWith('/check-vpn')){
        if(!vpn)throw Error('Клиент VPN не установлен');
        if(configuring)throw Error('Настройки уже применяются');
        configuring=true;ownsLock=true;
        return send(200,await vpn.check(store.data.config));
      }
      if(req.url.endsWith('/check')){if(!store.data.config.botToken)throw Error('Сначала сохраните токен бота');const bot=await worker.telegram('getMe',{});const hook=await worker.telegram('getWebhookInfo',{});return send(200,{username:bot.username,business:!!bot.can_connect_to_business,webhook:!!hook.url});}
      if(configuring||previewing)throw Error('Настройки или проверка уже выполняются');
      configuring=true;ownsLock=true;worker.configuring=true;
      if(worker.busy && !(input.enabled===false && Object.keys(input).length===1))throw Error('Дождитесь завершения текущего сообщения');
      const previous=store.data.config,c=validate(input,previous);
      if(previous.enabled&&c.enabled)throw Error('Остановите бота перед изменением настроек');
      if(c.enabled&&c.botToken!==previous.botToken)throw Error('Сначала сохраните новый токен с выключенным ботом');

      if(c.enabled&&!previous.enabled){
        const bot=await worker.telegram('getMe',{}),hook=await worker.telegram('getWebhookInfo',{});
        if(!bot.can_connect_to_business)throw Error('Включите Business / Secretary Mode у бота в BotFather');
        if(hook.url)throw Error('У бота задан webhook другого сервиса. Используйте отдельного бота без webhook.');
        store.data.activatedAt=Math.floor(Date.now()/1000);
      }
      if(vpn&&(c.vpnEnabled!==previous.vpnEnabled||c.vlessUrl!==previous.vlessUrl)){
        try{if(c.vpnEnabled)await vpn.ensure(c);else await vpn.stop();}
        catch(e){if(previous.vpnEnabled)await vpn.ensure(previous).catch(()=>{});throw e;}
      }
      if(c.botToken!==previous.botToken){store.data.offset=0;store.data.connections={};store.data.jobs=[];}
      store.data.config=c;store.save();worker.pollController?.abort();return send(200,status());
    }catch(e){return send(400,{error:String(e.message).slice(0,200)});}
    finally{if(ownsLock){configuring=false;worker.configuring=false;}}
  });
}
if(require.main===module){
  const store=new Store(process.env.VOICE_DATA_DIR||'./data',process.env.VOICE_ENCRYPTION_KEY);
  const vpn=new (require('./vpn').Vpn)();const worker=new Worker(store,{vpn});
  if(store.data.config.vpnEnabled)vpn.ensure(store.data.config).catch(()=>{});const server=createServer(store,worker,process.env.VOICE_SERVICE_TOKEN||'');
  if(!process.env.VOICE_SERVICE_TOKEN)throw Error('Нужен VOICE_SERVICE_TOKEN');
  server.listen(Number(process.env.VOICE_PORT||7500),'127.0.0.1');worker.run();
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{worker.stopped=true;vpn.stop().catch(()=>{});store.data.config.enabled&&store.save();worker.pollController?.abort();server.close();setTimeout(()=>process.exit(0),1000).unref();});
}
module.exports={createServer};
