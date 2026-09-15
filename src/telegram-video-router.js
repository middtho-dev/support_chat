'use strict';
const path=require('path'),crypto=require('crypto');
const {WebhookInbox}=require('../tools/voice/webhook');
function isVideoUpdate(update,username=''){
 if(update.guest_message)return true;
 const m=update.message;if(!m||m.from?.is_bot)return false;
 const text=m.text||m.caption||'';
 const command=text.match(/^\/video(?:@([\w]+))?(?:\s|$)/i);
 if(command)return !command[1]||command[1].toLowerCase()===username.toLowerCase();
 const mentions=text.match(/@[A-Za-z0-9_]+/g)||[];
 const addressed=username&&mentions.some(v=>v.slice(1).toLowerCase()===username.toLowerCase());
 return !!(addressed&&(/https?:\/\//i.test(text)||m.reply_to_message));
}
function createVideoRouter({token=process.env.VIDEO_SHARED_BOT==='1'?process.env.VIDEO_SERVICE_TOKEN:'',url=process.env.VIDEO_SERVICE_URL||'http://127.0.0.1:7800',dir=path.join(path.dirname(process.env.DB_PATH||path.join(__dirname,'../data/support.db')),'video-forward',crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN||'unconfigured').digest('hex').slice(0,16)),fetchImpl=fetch}={}){
 let inbox;
 return {
  route(update,username){
   if(!token||!isVideoUpdate(update,username))return false;
   if(!inbox)inbox=new WebhookInbox({dir,secret:crypto.createHash('sha256').update(token).digest('hex'),handle:async item=>{
    const r=await fetchImpl(new URL('/api/video/update',url),{method:'POST',redirect:'error',headers:{'x-admin-token':token,'Content-Type':'application/json'},body:JSON.stringify(item),signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw Error('Video handoff unavailable');
   }});
   // Polling's message event has no update_id; derive a stable, safe integer.
   if(!Number.isSafeInteger(update.update_id)){const m=update.guest_message||update.message;update={...update,update_id:parseInt(crypto.createHash('sha256').update(JSON.stringify([m.chat?.id,m.message_id,m.guest_query_id])).digest('hex').slice(0,12),16)};}
   inbox.accept(update);return true;
  },
  flush:()=>inbox?.drain(),
  status:()=>inbox?.status()||{pending:0},
  stop:()=>inbox?.stop()
 };
}
module.exports={createVideoRouter,isVideoUpdate};
