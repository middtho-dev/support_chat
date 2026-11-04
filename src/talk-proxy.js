'use strict';
function createTalkProxy({authorize,base=process.env.KV9_TALK_URL||'http://127.0.0.1:39400',token=process.env.KV9_TALK_ADMIN_TOKEN,request=fetch}){
 const express=require('express'),router=express.Router();
 router.use((req,res,next)=>{const access=authorize(req.get('x-admin-token'));if(!access?.authenticated)return res.status(401).json({error:'Требуется вход'});if(!access.canManageSettings)return res.status(403).json({error:'Нет прав управления'});req.talkActor=access.actor||'owner';next();});
 router.use(express.json({limit:'32kb'}));
 router.use(async(req,res)=>{
  res.set('Cache-Control','no-store');
  const allowed={'GET /state':'/admin/state','PUT /settings':'/admin/settings','POST /accounts':'/admin/accounts','POST /rooms':'/admin/rooms','POST /releases/activate':'/admin/releases/activate'};
  const endpoint=allowed[req.method+' '+req.path];if(!endpoint)return res.status(404).json({error:'Команда не найдена'});
  if(!token)return res.status(503).json({error:'Служебное подключение Talk не настроено'});
  try{const response=await request(new URL(endpoint,base),{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Talk-Actor':String(req.talkActor).slice(0,80)},body:req.method==='GET'?undefined:JSON.stringify(req.body),signal:AbortSignal.timeout(15000),redirect:'error'});const data=await response.json();res.status(response.status).json(data);}catch{res.status(503).json({error:'Сервис Talk недоступен. Повторите позже.'});}
 });
 return router;
}
module.exports={createTalkProxy};
