'use strict';
const path=require('path'),crypto=require('crypto'),{WebhookInbox}=require('../tools/voice/webhook');
const {command}=require('../tools/knowledge/brain');
function createKnowledgeRouter({token=process.env.KNOWLEDGE_SERVICE_TOKEN,url=process.env.KNOWLEDGE_SERVICE_URL||'http://127.0.0.1:7900',dir=path.join(path.dirname(process.env.DB_PATH||path.join(__dirname,'../data/support.db')),'knowledge-forward'),fetchImpl=fetch}={}){
 const inbox=token?new WebhookInbox({dir,secret:crypto.createHash('sha256').update(token).digest('hex'),handle:async item=>{
  const r=await fetchImpl(new URL('/api/knowledge/update',url),{method:'POST',redirect:'error',headers:{'x-admin-token':token,'Content-Type':'application/json'},body:JSON.stringify(item),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('База знаний недоступна');
 }}):null;
 return{
  route(update,username){
   if(!inbox||!command(update,username))return false;
   const updateId=update.update_id??parseInt(crypto.createHash('sha256').update(String(update.message.chat.id)+':'+update.message.message_id).digest('hex').slice(0,12),16);
   inbox.accept({update_id:updateId,update,username});return true;
  },
  drain:()=>inbox?.drain(),stop:()=>inbox?.stop(),status:()=>inbox?.status()
 };
}
module.exports={createKnowledgeRouter};
