'use strict';

// Every main-chat reply names a persisted source message. Never route plain
// messages to a mutable "currently selected" ticket, including photo albums.
function createSupportInbox({db, send, enabled, authorized, operators, retryDelay, onError, remove, expired}) {
  const sql=db.db;
  const enqueue=sql.prepare('INSERT OR IGNORE INTO telegram_support_inbox(message_id,operator_id) VALUES (?,?)');
  const get=sql.prepare('SELECT *,next_retry_at<=CURRENT_TIMESTAMP AS ready FROM telegram_support_inbox WHERE message_id=? AND operator_id=?');
  const delivered=sql.prepare('UPDATE telegram_support_inbox SET sent_message_id=?,last_error=NULL WHERE message_id=? AND operator_id=?');
  const failed=sql.prepare('UPDATE telegram_support_inbox SET attempts=attempts+1,last_error=?,next_retry_at=datetime(\'now\',?) WHERE message_id=? AND operator_id=?');
  const pending=sql.prepare(`SELECT i.* FROM telegram_support_inbox i JOIN messages m ON m.id=i.message_id
    JOIN tickets t ON t.id=m.ticket_id WHERE i.sent_message_id IS NULL AND i.next_retry_at<=CURRENT_TIMESTAMP
    AND t.status='open' ORDER BY m.created_at,m.rowid LIMIT 20`);
  const saveTarget=sql.prepare(`INSERT OR REPLACE INTO telegram_support_reply_targets
    (chat_id,telegram_message_id,message_id,operator_id,media_group_id,response_id) VALUES (?,?,?,?,?,?)`);
  const target=sql.prepare('SELECT * FROM telegram_support_reply_targets WHERE chat_id=? AND telegram_message_id=? AND operator_id=?');
  const album=sql.prepare(`SELECT * FROM telegram_support_reply_targets WHERE chat_id=? AND media_group_id=?
    AND operator_id=? AND created_at>datetime('now','-10 minutes') ORDER BY created_at DESC LIMIT 1`);
  const responseTarget=sql.prepare('SELECT message_id FROM telegram_support_reply_targets WHERE chat_id=? AND response_id=? LIMIT 1');
  const answered=sql.prepare(`UPDATE telegram_support_reply_targets SET cleanup_pending=1
    WHERE chat_id=? AND message_id=? AND (response_id IS NULL OR response_id=?) AND cleanup_pending!=2`);
  const cleanup=sql.prepare(`SELECT * FROM telegram_support_reply_targets WHERE cleanup_pending=1
    AND cleanup_retry_at<=CURRENT_TIMESTAMP LIMIT 20`);
  // Keep the binding after deletion: later album updates may arrive without Reply.
  const cleaned=sql.prepare('UPDATE telegram_support_reply_targets SET cleanup_pending=2,cleanup_error=NULL WHERE chat_id=? AND telegram_message_id=?');
  const cleanupFailed=sql.prepare(`UPDATE telegram_support_reply_targets SET cleanup_attempts=cleanup_attempts+1,
    cleanup_retry_at=datetime('now',?),cleanup_error=?,cleanup_pending=? WHERE chat_id=? AND telegram_message_id=?`);
  const busy=new Map();
  const remember=(chatId,telegramId,messageId,operatorId,group=null,responseId=null)=>saveTarget.run(String(chatId),telegramId,messageId,String(operatorId),group,responseId);
  async function deliver(job) {
    const key=job.message_id+':'+job.operator_id;
    if(busy.has(key))return busy.get(key);
    const task=(async()=>{
      const record=get.get(job.message_id,job.operator_id);
      if(!record||!record.ready||record.sent_message_id||!enabled()||!authorized(job.operator_id))return;
      const message=db.getMessageById.get(job.message_id),ticket=message&&db.getTicketById.get(message.ticket_id);
      const operator=db.getTelegramOperator.get(job.operator_id);
      if(!ticket||ticket.status!=='open'||!operator?.active||
        (ticket.assigned_operator_id&&String(ticket.assigned_operator_id)!==job.operator_id))return;
      if(db.deliveryHeld.get('operator',message.id))return;
      try {
        const sent=await send(ticket,message,job.operator_id,id=>remember(job.operator_id,id,message.id,job.operator_id));
        if(!sent?.message_id)throw Error('Telegram did not confirm inbox delivery');
        delivered.run(sent.message_id,message.id,job.operator_id);
      } catch(error) {
        failed.run(String(error.message||error).slice(0,1000),'+'+retryDelay(record.attempts+1,error)+' seconds',job.message_id,job.operator_id);
        onError(error);
      }
    })();
    busy.set(key,task);
    try{return await task;}finally{busy.delete(key);}
  }
  return {
    remember,
    answered(message) {
      if(!message?.telegram_chat_id)return;
      const source=message.reply_to_id||responseTarget.get(String(message.telegram_chat_id),message.id)?.message_id;
      if(!source)return;
      return answered.run(String(message.telegram_chat_id),source,message.id).changes>0;
    },
    target:msg=>target.get(String(msg.chat?.id||''),Number(msg.reply_to_message?.message_id||0),String(msg.from?.id||''))||
      (msg.media_group_id?album.get(String(msg.chat?.id||''),String(msg.media_group_id),String(msg.from?.id||'')):null),
    source:(chatId,messageId,operatorId)=>target.get(String(chatId),messageId,String(operatorId)),
    async publish(ticket,message) {
      if(message.sender!=='user'||!enabled())return;
      const recipients=ticket.assigned_operator_id
        ? [db.getTelegramOperator.get(String(ticket.assigned_operator_id))]
        : operators();
      const jobs=recipients.filter(op=>op?.active&&authorized(op.telegram_user_id)).map(op=>{
        enqueue.run(message.id,String(op.telegram_user_id));
        return {message_id:message.id,operator_id:String(op.telegram_user_id)};
      });
      for(const job of jobs)await deliver(job);
    },
    async retry(){for(const job of pending.all())await deliver(job);},
    async cleanup() {
      for(const item of cleanup.all()) {
        let permanent=expired(item.created_at)?'Telegram deletion window expired':'';
        const removed=!permanent&&await remove(item.chat_id,item.telegram_message_id,reason=>{permanent=reason;});
        if(removed)cleaned.run(item.chat_id,item.telegram_message_id);
        else cleanupFailed.run('+'+retryDelay(item.cleanup_attempts+1)+' seconds',permanent||'Telegram did not confirm deletion',permanent?0:1,item.chat_id,item.telegram_message_id);
      }
    }
  };
}
module.exports={createSupportInbox};
