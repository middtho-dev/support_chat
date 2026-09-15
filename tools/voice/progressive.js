'use strict';
const {ids}=require('./config');
const {shouldDelete}=require('./formatting');
const parts=text=>{const chars=Array.from(text),out=[];for(let i=0;i<chars.length;i+=1800)out.push(chars.slice(i,i+1800).join(''));return out;};
const rich=text=>({html:'<p>'+text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')+'</p>'});

async function processProgressive(worker,job,c){
  const store=worker.store;job.progressive=true;job.outputIds ||= [];job.outputTexts ||= [];
  const active=()=>!worker.stopped&&store.data.config.enabled&&job.status!=='cancelled';
  const guard=()=>{if(!active()){const e=Error('Обработка приостановлена');e.paused=true;throw e;}};
  const connection=async()=>{
    guard();const conn=await worker.telegram('getBusinessConnection',{business_connection_id:job.connectionId});
    store.data.connections[job.connectionId]=conn;
    if(!conn.is_enabled||!conn.rights?.can_reply||!ids(store.data.config.ownerIds).includes(String(conn.user?.id)))throw Object.assign(Error('Нет права отвечать от аккаунта'),{retryable:false});
    guard();return conn;
  };
  const write=async(text,index=0)=>{
    guard();if(job.outputTexts[index]===text)return;
    const existing=job.outputIds[index];
    const useRich=c.richMessages&&job.richSupported!==false;
    const method=existing?'editMessageText':useRich?'sendRichMessage':'sendMessage';
    const body={business_connection_id:job.connectionId,chat_id:job.chatId,...(existing?{message_id:existing}:{disable_notification:c.silent}),...(useRich?{rich_message:rich(text)}:{text,link_preview_options:{is_disabled:true}})};
    if(!existing){job.progressSending=true;store.save();}
    let result;
    try{result=await worker.telegram(method,body);}
    catch(e){
      if(existing&&e.notModified){job.outputTexts[index]=text;store.save();return;}
      // Only an explicit API rejection permits retrying a send in another format.
      if(useRich&&(e.code===400||e.code===403)&&e.richUnavailable){job.progressSending=false;job.richSupported=false;store.save();return write(text,index);}
      if(!existing){
        if([400,401,403,404,429].includes(e.code)){job.progressSending=false;store.save();}
        else{job.status='uncertain';job.error='Нет подтверждения отправки. Проверьте чат перед повтором.';store.save();}
      }
      throw e;
    }
    if(!existing){
      if(!Number.isSafeInteger(result?.message_id)){job.status='uncertain';throw Error('Telegram не подтвердил ID сообщения');}
      job.outputIds[index]=result.message_id;job.progressSending=false;
      job.firstTextMs ??= Date.now()-job.created;
    }
    job.outputTexts[index]=text;job.lastTextAt=Date.now();store.save();
  };
  const preview=async text=>{
    if(!c.smoothText||!active()||Array.from(text).length<24||Date.now()-(job.lastTextAt||0)<1500)return;
    await write(parts((c.prefix?c.prefix+'\n':'')+text)[0]+' …');
  };
  try{
    job.startedAt ||= Date.now();job.queueMs ??= job.startedAt-job.created;job.attempts=(job.attempts||0)+1;store.save();
    let conn=await connection();
    if(!job.rawText){
      job.rawText=await worker.timed(job,'audio',()=>worker.transcribe(job,c,preview));guard();store.save();
    }
    const rawParts=parts((c.prefix?c.prefix+'\n':'')+job.rawText);
    // Persist the first portion immediately. Longer output is finalized below.
    if(!job.formatted)await write(rawParts[0]+(rawParts.length>1?' …':''));
    if(!job.formatted){
      job.text=job.rawText;
      if(c.polish||c.emoji){
        try{job.text=await worker.timed(job,'polish',()=>worker.polish(job.rawText,c,30000));}
        catch(e){job.formatWarning='Оформление не выполнено; сохранена исходная расшифровка.';}
      }
      guard();job.formatted=true;store.save();
    }
    conn=await connection();
    const final=parts((c.prefix?c.prefix+'\n':'')+job.text);
    for(let i=0;i<final.length;i++)await worker.timed(job,'delivery',()=>write(final[i],i));
    guard();
    if(!job.formatWarning&&shouldDelete(store.data.config,job,conn)&&conn.rights?.can_delete_all_messages){
      job.stage='cleanup';store.save();await worker.telegram('deleteBusinessMessages',{business_connection_id:job.connectionId,message_ids:[job.messageId]});
    }
    job.status='done';job.error=job.formatWarning||'';job.stage='';job.finishedAt=Date.now();store.save();
  }catch(e){
    if(e.paused||job.status==='cancelled')return;
    if(job.status!=='uncertain'){
      job.error=String(e.message).slice(0,300);
      job.status=e.retryable===false||[400,401,403,404].includes(e.code)||job.attempts>=3?'failed':'pending';
      job.next=Date.now()+Math.max(1,Number(e.retryAfter)||5)*1000;
    }
    job.stage='';if(['failed','uncertain'].includes(job.status))job.finishedAt=Date.now();store.save();
  }
}
module.exports={processProgressive,rich};
