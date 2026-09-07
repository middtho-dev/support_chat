'use strict';
function createLampacProxy({authorize,url=process.env.LAMPAC_SERVICE_URL||'http://127.0.0.1:7600',token=process.env.LAMPAC_SERVICE_TOKEN,fetcher=fetch}={}){
  return async(req,res)=>{
    res.set('Cache-Control','no-store');const access=authorize(req.get('x-admin-token'));
    if(!access.authenticated)return res.status(401).json({error:'Требуется вход'});
    if(!access.canManageSettings)return res.status(403).json({error:'Нужны права управления'});
    const suffix=req.path==='/'?'':req.path;
    if(!(req.method==='GET'&&['','/torrserver','/advanced','/torrents','/clients','/devices'].includes(suffix)||req.method==='POST'&&['/configure','/action','/torrserver','/advanced','/client','/torrents','/clients','/devices'].includes(suffix)))return res.sendStatus(404);
    if(!token)return res.status(503).json({error:'Сервис управления Lampac ещё не подключён'});
    try{
      const r=await fetcher(new URL('/api/lampac'+suffix,url),{method:req.method,redirect:'error',headers:{'x-admin-token':token,'Content-Type':'application/json'},...(req.method==='POST'?{body:JSON.stringify(req.body||{})}:{}),signal:AbortSignal.timeout(30000)});
      res.status(r.status).json(await r.json());
    }catch{res.status(502).json({error:'Управление Lampac временно недоступно. Обновите статус перед повтором команды.'});}
  };
}
module.exports={createLampacProxy};
