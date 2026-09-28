'use strict';
const http=require('http'),crypto=require('crypto');
const {Store,validate,defaults}=require('./store');
const {Brain}=require('./brain');
function createServer(store,account,brain,token){if(!token)throw Error('Нужен KNOWLEDGE_SERVICE_TOKEN');let changing=false;
 const status=()=>({...store.status(),connected:account.live,telegramBusy:account.busy,loginStage:account.pending?(account.pending.twofa?'password':'code'):'phone',error:account.error,busy:brain.busy});
 return http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');const reply=(code,data)=>{res.statusCode=code;res.end(JSON.stringify(data));};
  if(req.url==='/health')return reply(200,{ok:true});
  const got=String(req.headers['x-admin-token']||'');if(!crypto.timingSafeEqual(crypto.createHash('sha256').update(got).digest(),crypto.createHash('sha256').update(token).digest()))return reply(401,{error:'Требуется вход'});
  const chunks=[];let size=0;try{for await(const chunk of req){size+=chunk.length;if(size>65536)return reply(413,{error:'Слишком большой запрос'});chunks.push(chunk);}const body=Buffer.concat(chunks).toString('utf8'),data=body?JSON.parse(body):{};
   if(req.method==='GET'&&req.url==='/api/knowledge')return reply(200,status());
   if(req.method!=='POST')return reply(404,{error:'Не найдено'});
   const route=req.url.replace('/api/knowledge','');
   if(route==='/update')return reply(200,brain.receive(data.update,data.username));
   if(route==='/query')return reply(200,brain.enqueue({kind:data.kind,query:data.query||'',chatId:data.chatId||''}));
   if(changing)return reply(409,{error:'Другая операция ещё выполняется'});changing=true;
   try{
    if(route==='/configure'){
     const config={...store.state.config},secrets={...store.state.secrets};for(const k of Object.keys(defaults))if(k in data)config[k]=data[k];validate(config);
     if(data.apiId||data.apiHash){if(account.client)throw Error('Сначала отключите текущую сессию Telegram');if(!/^\d{3,12}$/.test(String(data.apiId))||!(/^[a-f0-9]{32}$/i.test(data.apiHash||store.state.secrets.apiHash||'')))throw Error('Проверьте API ID и API Hash');secrets.apiId=String(data.apiId);if(data.apiHash)secrets.apiHash=data.apiHash;}
     if(data.openaiKey){if(typeof data.openaiKey!=='string'||data.openaiKey.length>500)throw Error('Некорректный API-ключ');secrets.openaiKey=data.openaiKey.trim();}
     store.state.config=config;store.state.secrets=secrets;store.save();
    }else if(route==='/code')return reply(200,await account.sendCode(data.phone||''));
    else if(route==='/login')return reply(200,await account.login(data.code,data.password));
    else if(route==='/disconnect')await account.disconnect();
    else if(route==='/dialogs')await account.dialogs();
    else if(route==='/select'){if(typeof data.selected!=='boolean')throw Error('Неверный выбор');store.select(String(data.id),data.selected);}
    else if(route==='/purge'){if(brain.busy||account.busy)throw Error('Дождитесь завершения обработки и импорта');store.purge(String(data.id));}
    else return reply(404,{error:'Не найдено'});
    reply(200,status());
   }finally{changing=false;}
  }catch(e){reply(400,{error:e.errorMessage||e.message||'Не удалось выполнить операцию'});}
 });
}
if(require.main===module){const store=new Store(process.env.DATA_DIR||'/app/data',process.env.KNOWLEDGE_ENCRYPTION_KEY);const {Account}=require('./telegram');const account=new Account(store),brain=new Brain(store);createServer(store,account,brain,process.env.KNOWLEDGE_SERVICE_TOKEN).listen(Number(process.env.PORT||7900),'127.0.0.1');account.restore().finally(()=>account.start());brain.start();process.on('SIGTERM',()=>{store.db.close();process.exit(0);});}
module.exports={createServer};
