'use strict';
function createKnowledgeProxy({authorize,url=process.env.KNOWLEDGE_SERVICE_URL||'http://127.0.0.1:7900',token=process.env.KNOWLEDGE_SERVICE_TOKEN}={}){
 return async(req,res)=>{res.set('Cache-Control','no-store');const access=authorize(req.get('x-admin-token'));if(!access.authenticated)return res.status(401).json({error:'Требуется вход'});if(!access.canManageSettings)return res.status(403).json({error:'Нужны права управления'});const suffix=req.path==='/'?'':req.path;
  if(!(req.method==='GET'&&!suffix||req.method==='POST'&&['/configure','/code','/login','/disconnect','/dialogs','/select','/purge','/query'].includes(suffix)))return res.sendStatus(404);
  if(!token)return res.status(503).json({error:'Сервис базы знаний ещё не подключён'});
  try{const r=await fetch(new URL('/api/knowledge'+suffix,url),{method:req.method,redirect:'error',headers:{'x-admin-token':token,'Content-Type':'application/json'},...(req.method==='POST'?{body:JSON.stringify(req.body||{})}:{}),signal:AbortSignal.timeout(120000)});res.status(r.status).json(await r.json());}catch{res.status(502).json({error:'Сервис временно недоступен. Проверьте состояние перед повтором операции.'});}
 };
}
module.exports={createKnowledgeProxy};
