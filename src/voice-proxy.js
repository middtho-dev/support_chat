'use strict';
function createVoiceProxy({authorize,url=process.env.VOICE_SERVICE_URL||'http://127.0.0.1:7500',token=process.env.VOICE_SERVICE_TOKEN}={}){
  return async(req,res)=>{
    res.set('Cache-Control','no-store');const access=authorize(req.get('x-admin-token'));
    if(!access.authenticated)return res.status(401).json({error:'Требуется вход'});
    if(!access.canManageSettings)return res.status(403).json({error:'Нужны права управления'});
    const suffix=req.path==='/'?'':req.path;
    if(!(req.method==='GET'&&!suffix||req.method==='POST'&&['/configure','/check'].includes(suffix)))return res.sendStatus(404);
    if(!token)return res.status(503).json({error:'Сервис расшифровки ещё не подключён'});
    if(req.body?.botToken && req.body.botToken === process.env.TELEGRAM_BOT_TOKEN)return res.status(400).json({error:'Для расшифровки нужен отдельный бот, не бот поддержки'});
    try{const r=await fetch(new URL('/api/voice'+suffix,url),{method:req.method,redirect:'error',headers:{'x-admin-token':token,'Content-Type':'application/json'},...(req.method==='POST'?{body:JSON.stringify(req.body||{})}:{}),signal:AbortSignal.timeout(35000)});res.status(r.status).json(await r.json());}
    catch{res.status(502).json({error:'Сервис расшифровки временно недоступен'});}
  };
}
module.exports={createVoiceProxy};
