'use strict';

// One active operator card per ticket. Telegram effects are serialized per card;
// refreshes, routing aliases and cleanup survive a process/container restart.
function createSupportDialogs({db, enabled, authorized, send, edit, model, keyboard, remove,
  removeTopic, expired, retryDelay, errorText, onError, clock=Date.now}) {
  const sql=db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS telegram_operator_dialogs (
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      operator_id TEXT NOT NULL, message_id INTEGER, dirty INTEGER NOT NULL DEFAULT 1,
      notify INTEGER NOT NULL DEFAULT 0, last_user_id TEXT, last_alert_at INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      PRIMARY KEY(ticket_id,operator_id)
    );
    CREATE TABLE IF NOT EXISTS telegram_operator_dialog_messages (
      chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      operator_id TEXT NOT NULL, kind TEXT NOT NULL, source_message_id TEXT,
      response_id TEXT, media_group_id TEXT, created_at INTEGER NOT NULL,
      cleanup INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
      PRIMARY KEY(chat_id,message_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dialog_message_ticket ON telegram_operator_dialog_messages(ticket_id);
    CREATE INDEX IF NOT EXISTS idx_dialog_cleanup ON telegram_operator_dialog_messages(cleanup,next_retry_at);
    CREATE TABLE IF NOT EXISTS telegram_operator_old_topics (
      ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      operator_id TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, next_retry_at INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,
      PRIMARY KEY(chat_id,thread_id)
    );
  `);
  if(!sql.prepare('PRAGMA table_info(telegram_operator_dialogs)').all().some(c=>c.name==='view'))sql.exec("ALTER TABLE telegram_operator_dialogs ADD COLUMN view TEXT NOT NULL DEFAULT 'dialog'");
  const state=sql.prepare('SELECT * FROM telegram_operator_dialogs WHERE ticket_id=? AND operator_id=?');
  const request=sql.prepare(`INSERT INTO telegram_operator_dialogs(ticket_id,operator_id,notify) VALUES (?,?,?)
    ON CONFLICT(ticket_id,operator_id) DO UPDATE SET dirty=1,notify=MAX(notify,excluded.notify),
      view=CASE WHEN excluded.notify=1 THEN 'dialog' ELSE view END`);
  const track=sql.prepare(`INSERT OR IGNORE INTO telegram_operator_dialog_messages
    (chat_id,message_id,ticket_id,operator_id,kind,source_message_id,response_id,media_group_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const route=sql.prepare(`SELECT * FROM telegram_operator_dialog_messages WHERE chat_id=? AND message_id=? AND operator_id=?`);
  const album=sql.prepare(`SELECT * FROM telegram_operator_dialog_messages WHERE chat_id=? AND media_group_id=? AND operator_id=? AND created_at>?
    ORDER BY created_at DESC,message_id DESC LIMIT 1`);
  const enqueue=sql.prepare(`UPDATE telegram_operator_dialog_messages SET cleanup=1,next_retry_at=0
    WHERE chat_id=? AND message_id=? AND cleanup IN (0,1)`);
  const queues=new Map();
  const exclusive=(key,work)=>{
    const task=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(work);queues.set(key,task);
    task.finally(()=>{if(queues.get(key)===task)queues.delete(key);}).catch(()=>{});return task;
  };
  function remember(chat,id,ticket,operator,kind,source=null,response=null,group=null) {
    if(id)track.run(String(chat),Number(id),ticket,String(operator),kind,source,response,group,clock());
  }
  async function erase(item) {
    let permanent=expired(new Date(item.created_at).toISOString().slice(0,19).replace('T',' '))?'Telegram deletion window expired':'';
    const ok=!permanent&&await remove(item.chat_id,item.message_id,reason=>{permanent=reason;});
    if(ok)sql.prepare('UPDATE telegram_operator_dialog_messages SET cleanup=2,last_error=NULL WHERE chat_id=? AND message_id=?').run(item.chat_id,item.message_id);
    else sql.prepare(`UPDATE telegram_operator_dialog_messages SET cleanup=?,attempts=attempts+1,next_retry_at=?,last_error=? WHERE chat_id=? AND message_id=?`)
      .run(permanent?3:1,clock()+retryDelay(item.attempts+1)*1000,permanent||'Telegram did not confirm deletion',item.chat_id,item.message_id);
    return ok||!!permanent;
  }
  function retire(ticket,operator,kind) {
    sql.prepare(`UPDATE telegram_operator_dialog_messages SET cleanup=1,next_retry_at=0 WHERE ticket_id=? AND operator_id=? AND kind=? AND cleanup=0`)
      .run(ticket,String(operator),kind);
  }
  function migrateLegacy(ticketId,operator) {
    const op=String(operator),ids=new Set();
    for(const row of db.getTelegramNotificationsForTicket.all(ticketId))if(row.operator_id===op)ids.add(row.message_id);
    for(const row of db.getTelegramRemindersForTicket.all(ticketId))if(row.operator_id===op)ids.add(row.message_id);
    for(const row of sql.prepare('SELECT * FROM telegram_support_reply_targets WHERE message_id IN (SELECT id FROM messages WHERE ticket_id=?) AND operator_id=?').all(ticketId,op))ids.add(row.telegram_message_id);
    for(const row of sql.prepare('SELECT telegram_message_id FROM messages WHERE ticket_id=? AND telegram_chat_id=?').all(ticketId,op))ids.add(row.telegram_message_id);
    for(const row of sql.prepare('SELECT * FROM telegram_ticket_threads WHERE ticket_id=?').all(ticketId))if(row.operator_id===op) {
      ids.add(row.root_message_id);
      sql.prepare('INSERT OR IGNORE INTO telegram_operator_old_topics(ticket_id,operator_id,chat_id,thread_id) VALUES (?,?,?,?)').run(ticketId,op,row.chat_id,row.thread_id);
    }
    const current=state.get(ticketId,op)?.message_id;
    for(const id of ids)if(id&&id!==current&&!route.get(op,id,op)){remember(op,id,ticketId,op,'legacy');enqueue.run(op,id);}
    sql.prepare('DELETE FROM telegram_ticket_notifications WHERE ticket_id=? AND operator_id=?').run(ticketId,op);
    sql.prepare('DELETE FROM telegram_ticket_reminders WHERE ticket_id=? AND operator_id=?').run(ticketId,op);
  }
  async function render(ticketId,operator,forceNotify=false) {
    let row=state.get(ticketId,operator),ticket=db.getTicketById.get(ticketId);
    if(!row||!enabled()||!authorized(operator))return null;
    if(!ticket||ticket.status!=='open'||(ticket.assigned_operator_id&&String(ticket.assigned_operator_id)!==operator)) {
      await closeForOperator(ticketId,operator);return null;
    }
    if(row.next_retry_at>clock()&&(!forceNotify||row.attempts>0))return row.attempts?null:(row.message_id?{message_id:row.message_id}:null);
    const user=db.getLatestUserMessageForTicket.get(ticketId);
    const latest=sql.prepare("SELECT sender FROM messages WHERE ticket_id=? AND sender!='system' AND COALESCE(is_auto,0)=0 ORDER BY created_at DESC,rowid DESC LIMIT 1").get(ticketId);
    const notification=!!row.notify&&!!user&&latest?.sender==='user'&&(forceNotify||row.last_user_id!==user.id);
    const due=notification&&(forceNotify||clock()-row.last_alert_at>=3000);
    try {
      const content=model(ticket,{view:row.view}),markup=content.replyMarkup||keyboard(ticket,ticket.assigned_operator_id?'open':'unassigned');
      let id=row.message_id;
      const oldCard=id?route.get(operator,id,operator):null;
      const rotate=oldCard&&clock()-oldCard.created_at>=24*60*60*1000;
      if(id&&(due||rotate)) {
        const old=route.get(operator,id,operator);
        if(old&&!await erase(old))throw Error('Cannot replace notification until the old card is removed');
        sql.prepare('UPDATE telegram_operator_dialogs SET message_id=NULL WHERE ticket_id=? AND operator_id=?').run(ticketId,operator);id=null;
      }
      if(id) {
        const ok=await edit(operator,id,content.rich||content.markdown,markup,content.fallback);
        if(!ok){enqueue.run(operator,id);id=null;}
      }
      if(!id) {
        const sent=await send(operator,content.rich||content.markdown,{reply_markup:markup,disable_notification:!notification},content.fallback);
        if(!sent?.message_id)throw Error('Telegram did not confirm dialog delivery');
        id=sent.message_id;remember(operator,id,ticketId,operator,'card');
      }
      // A close can race the Telegram request. Record the new ID before retiring it.
      sql.prepare(`UPDATE telegram_operator_dialogs SET message_id=?,dirty=?,notify=?,last_user_id=?,last_alert_at=?,attempts=0,next_retry_at=?,last_error=NULL WHERE ticket_id=? AND operator_id=?`)
        .run(id,notification&&!due?1:0,notification&&!due?1:0,notification&&(!row.message_id||due)?user.id:row.last_user_id,
          notification&&(!row.message_id||due)?clock():row.last_alert_at,notification&&!due?row.last_alert_at+3000:0,ticketId,operator);
      ticket=db.getTicketById.get(ticketId);
      if(ticket.status!=='open'){await closeForOperator(ticketId,operator);return null;}
      migrateLegacy(ticketId,operator);
      return {message_id:id};
    } catch(error) {
      sql.prepare(`UPDATE telegram_operator_dialogs SET dirty=1,attempts=attempts+1,next_retry_at=?,last_error=? WHERE ticket_id=? AND operator_id=?`)
        .run(clock()+retryDelay(row.attempts+1,error)*1000,errorText(error).slice(0,1000),ticketId,operator);
      onError(error);throw error;
    }
  }
  async function closeForOperator(ticketId,operator) {
    migrateLegacy(ticketId,operator);
    sql.prepare('UPDATE telegram_operator_dialog_messages SET cleanup=1,next_retry_at=0 WHERE ticket_id=? AND operator_id=? AND cleanup=0').run(ticketId,operator);
    sql.prepare('UPDATE telegram_operator_dialogs SET message_id=NULL,dirty=0,notify=0 WHERE ticket_id=? AND operator_id=?').run(ticketId,operator);
  }
  return {
    remember,
    setView(ticket,op,view){sql.prepare('UPDATE telegram_operator_dialogs SET view=?,dirty=1,next_retry_at=0 WHERE ticket_id=? AND operator_id=?').run(view,ticket,String(op));},
    get:(ticket,op)=>state.get(ticket,String(op)),
    sync(ticket,op,{notify=false,reminder=false}={}) {
      const operator=String(op);request.run(ticket.id,operator,notify||reminder?1:0);
      return exclusive(ticket.id+':'+operator,()=>render(ticket.id,operator,reminder));
    },
    target(msg) {
      const chat=String(msg.chat?.id||''),op=String(msg.from?.id||'');
      const item=route.get(chat,Number(msg.reply_to_message?.message_id||0),op)||
        (msg.media_group_id?album.get(chat,String(msg.media_group_id),op,clock()-10*60*1000):null);
      if(!item)return null;
      const source=item.source_message_id||db.getLatestUserMessageForTicket.get(item.ticket_id)?.id||null;
      return {ticket_id:item.ticket_id,operator_id:op,message_id:source};
    },
    retire,
    async prompt(ticket,operator,source,sendPrompt) {
      const op=String(operator);
      return exclusive('prompt:'+op,async()=>{
        for(const item of sql.prepare("SELECT * FROM telegram_operator_dialog_messages WHERE operator_id=? AND kind='prompt' AND cleanup=0").all(op)) {
          enqueue.run(op,item.message_id);await erase(item);
        }
        const sent=await sendPrompt();remember(op,sent.message_id,ticket.id,op,'prompt',source?.id||null);return sent;
      });
    },
    answered(message) {
      if(!message?.telegram_chat_id)return false;
      const item=sql.prepare('SELECT * FROM telegram_operator_dialog_messages WHERE chat_id=? AND response_id=? LIMIT 1').get(String(message.telegram_chat_id),message.id);
      if(!item||item.cleanup!==0)return false;
      enqueue.run(item.chat_id,item.message_id);
      retire(item.ticket_id,item.operator_id,'prompt');retire(item.ticket_id,item.operator_id,'preview');
      return true;
    },
    async close(ticket) {
      const operators=new Set([
        ...sql.prepare('SELECT operator_id FROM telegram_operator_dialogs WHERE ticket_id=?').all(ticket.id).map(r=>r.operator_id),
        ...sql.prepare('SELECT * FROM telegram_ticket_threads WHERE ticket_id=?').all(ticket.id).map(r=>r.operator_id),
        ...db.getTelegramNotificationsForTicket.all(ticket.id).map(r=>r.operator_id)
      ]);
      for(const op of operators)await exclusive(ticket.id+':'+op,()=>closeForOperator(ticket.id,op));
      await this.cleanup(ticket.id);
    },
    async cleanup(ticketId=null) {
      for(const item of sql.prepare('SELECT * FROM telegram_operator_dialog_messages WHERE cleanup=1 AND next_retry_at<=? AND (? IS NULL OR ticket_id=?) LIMIT 100').all(clock(),ticketId,ticketId))await erase(item);
      for(const topic of sql.prepare('SELECT * FROM telegram_operator_old_topics WHERE done=0 AND next_retry_at<=? LIMIT 20').all(clock())) {
        try {
          await removeTopic(topic.chat_id,topic.thread_id);
          sql.prepare('UPDATE telegram_operator_old_topics SET done=1,last_error=NULL WHERE chat_id=? AND thread_id=?').run(topic.chat_id,topic.thread_id);
          db.deleteTelegramThread.run(topic.ticket_id,topic.operator_id);
        }catch(error) {
          const text=errorText(error);
          const gone=/thread not found|topic.*(deleted|invalid)|message_thread_id_invalid/i.test(text);
          sql.prepare('UPDATE telegram_operator_old_topics SET done=?,attempts=attempts+1,next_retry_at=?,last_error=? WHERE chat_id=? AND thread_id=?')
            .run(gone?1:0,clock()+retryDelay(topic.attempts+1,error)*1000,gone?null:text.slice(0,1000),topic.chat_id,topic.thread_id);
          if(gone)db.deleteTelegramThread.run(topic.ticket_id,topic.operator_id);
        }
      }
    },
    async retry() {
      if(!enabled())return;
      // Upgrade already-saved responses too; their delivery receipt stays independent.
      for(const row of sql.prepare(`SELECT m.* FROM messages m JOIN telegram_operator_dialog_messages d
        ON d.response_id=m.id WHERE d.kind='response' AND d.cleanup=0 LIMIT 100`).all())this.answered(row);
      sql.prepare(`UPDATE telegram_operator_dialogs SET dirty=1 WHERE message_id IN
        (SELECT message_id FROM telegram_operator_dialog_messages WHERE kind='card' AND cleanup=0 AND created_at<?)`).run(clock()-24*60*60*1000);
      for(const row of sql.prepare('SELECT * FROM telegram_operator_dialogs WHERE dirty=1 AND next_retry_at<=? LIMIT 30').all(clock())) {
        await exclusive(row.ticket_id+':'+row.operator_id,()=>render(row.ticket_id,row.operator_id)).catch(()=>{});
      }
      await this.cleanup();
    },
    diagnostics() {
      return {
        cards:sql.prepare('SELECT COUNT(*) n FROM telegram_operator_dialogs WHERE message_id IS NOT NULL').get().n,
        pending:sql.prepare('SELECT COUNT(*) n FROM telegram_operator_dialogs WHERE dirty=1').get().n,
        cleanupPending:sql.prepare('SELECT COUNT(*) n FROM telegram_operator_dialog_messages WHERE cleanup=1').get().n,
        cleanupBlocked:sql.prepare('SELECT COUNT(*) n FROM telegram_operator_dialog_messages WHERE cleanup=3').get().n,
        oldTopicsPending:sql.prepare('SELECT COUNT(*) n FROM telegram_operator_old_topics WHERE done=0').get().n
      };
    }
  };
}
module.exports={createSupportDialogs};
