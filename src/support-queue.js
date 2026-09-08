'use strict';
const express = require('express');
// Pausing delivery keeps the original message and is reversible. It is not a
// delivery receipt and never removes the conversation or Telegram message.
function createSupportQueue({database, authorize, service, settings}) {
  const router=express.Router(), db=database;
  const source=`WITH items AS (
    SELECT 'incoming' kind,q.chat_id||':'||q.message_id id,NULL ticket_id,'Telegram · '||q.chat_id title,
      q.payload content,'incoming' message_type,q.created_at,q.attempts,q.last_error error,q.next_retry_at retry_at,
      1 eligible,NULL blocked_reason
    FROM telegram_incoming_message_queue q
    UNION ALL
    SELECT 'operator',m.id,t.id,t.user_name,m.content,m.message_type,m.created_at,m.telegram_attempts,m.telegram_last_error,m.telegram_next_retry_at,
      CASE WHEN (CASE WHEN ?='private' THEN t.status='open' AND t.assigned_operator_id IS NOT NULL ELSE COALESCE(t.telegram_topic_deleted,0)=0 END) THEN 1 ELSE 0 END,
      CASE WHEN t.status!='open' THEN 'Обращение закрыто' WHEN ?='private' AND t.assigned_operator_id IS NULL THEN 'Оператор ещё не назначен' ELSE 'Тема Telegram недоступна' END
    FROM messages m JOIN tickets t ON t.id=m.ticket_id
    WHERE m.sender!='system' AND COALESCE(m.is_auto,0)=0 AND m.telegram_message_id IS NULL
    UNION ALL
    SELECT 'customer',m.id,t.id,t.user_name,m.content,m.message_type,m.created_at,m.telegram_customer_attempts,m.telegram_customer_last_error,m.telegram_customer_next_retry_at,
      CASE WHEN t.status='open' AND t.telegram_customer_chat_id IS NOT NULL THEN 1 ELSE 0 END,
      CASE WHEN t.status!='open' THEN 'Обращение закрыто' ELSE 'Не задан чат клиента' END
    FROM messages m JOIN tickets t ON t.id=m.ticket_id
    WHERE m.sender='support' AND t.source='telegram' AND m.telegram_customer_message_id IS NULL
  ), rows AS (SELECT i.*,CASE WHEN h.item_id IS NOT NULL THEN 'paused' WHEN eligible=0 THEN 'blocked' ELSE 'pending' END state
    FROM items i LEFT JOIN telegram_delivery_holds h ON h.kind=i.kind AND h.item_id=i.id)`;
  const mode=()=>service.status?.().mode||'legacy';
  const all=()=>[mode(),mode()];
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');const access=authorize(req.get('x-admin-token'));if(!access.authenticated)return res.status(401).json({error:'Нет доступа'});req.queueManager=access.canManageSettings;next();});
  router.get('/',(req,res)=>{
    const state=['pending','blocked','paused'].includes(req.query.state)?req.query.state:'pending';
    const offset=Math.max(0,Math.min(1000000,Number.parseInt(req.query.offset,10)||0));
    const counts={pending:0,blocked:0,paused:0};for(const r of db.prepare(source+' SELECT state,COUNT(*) n FROM rows GROUP BY state').all(...all()))counts[r.state]=r.n;
    const rows=db.prepare(source+' SELECT * FROM rows WHERE state=? ORDER BY created_at,id LIMIT 50 OFFSET ?').all(...all(),state,offset);
    for(const row of rows){if(row.eligible)row.blocked_reason=null;if(row.kind==='incoming'){try{const msg=JSON.parse(row.content);row.content=String(msg.text||msg.caption||'Медиа или служебное сообщение');}catch{row.content='Не удалось прочитать входящее сообщение';}}row.content=String(row.content||'['+row.message_type+']').slice(0,2000);row.busy=!!service.queueBusy?.(row.kind,row.id);if(row.state==='pending'&&!settings().telegramEnabled)row.blocked_reason='Бот поддержки выключен';}
    res.json({rows,counts,offset,limit:50,canManage:!!req.queueManager,enabled:!!settings().telegramEnabled});
  });
  router.post('/action',(req,res)=>{
    if(!req.queueManager)return res.status(403).json({error:'Изменять очередь может руководитель'});
    const {kind,id,action}=req.body||{};
    if(!['incoming','operator','customer'].includes(kind)||typeof id!=='string'||id.length>200||!['pause','retry','restore'].includes(action))return res.status(400).json({error:'Некорректная команда'});
    const row=db.prepare(source+' SELECT * FROM rows WHERE kind=? AND id=?').get(...all(),kind,id);
    if(!row)return res.status(404).json({error:'Запись уже обработана или отсутствует'});
    if(service.queueBusy?.(kind,id))return res.status(409).json({error:'Сообщение сейчас обрабатывается. Обновите очередь после завершения.'});
    if(action==='retry'&&!row.eligible)return res.status(409).json({error:row.blocked_reason});
    db.transaction(()=>{
      if(action==='pause'){db.prepare('INSERT OR IGNORE INTO telegram_delivery_holds(kind,item_id) VALUES (?,?)').run(kind,id);return;}
      db.prepare('DELETE FROM telegram_delivery_holds WHERE kind=? AND item_id=?').run(kind,id);
      if(kind==='incoming'){const split=id.lastIndexOf(':');db.prepare('UPDATE telegram_incoming_message_queue SET next_retry_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=?').run(id.slice(0,split),Number(id.slice(split+1)));}
      else {const column=kind==='operator'?'telegram_next_retry_at':'telegram_customer_next_retry_at';db.prepare(`UPDATE messages SET ${column}=NULL WHERE id=?`).run(id);}
    })();
    if(action==='retry'||(action==='restore'&&row.eligible))service.wakeDelivery?.();
    res.json({ok:true});
  });
  return router;
}
module.exports={createSupportQueue};
