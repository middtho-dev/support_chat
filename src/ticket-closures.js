'use strict';
function installTicketClosures(sql){
 sql.exec(`CREATE TABLE IF NOT EXISTS ticket_closure_delivery (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,extra_ids TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,next_retry_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL
 ); CREATE INDEX IF NOT EXISTS idx_closure_delivery_due ON ticket_closure_delivery(state,next_retry_at);`);
}
function createTicketClosures(sql,{clock=Date.now}={}){
 const get=id=>sql.prepare('SELECT * FROM ticket_closure_delivery WHERE ticket_id=?').get(id);
 const enqueue=sql.transaction((ticket,reason,ids)=>{
  const row=get(ticket.id);if(row)return row;
  sql.prepare('INSERT INTO ticket_closure_delivery(ticket_id,reason,extra_ids,created_at) VALUES (?,?,?,?)').run(ticket.id,reason,JSON.stringify(ids||[]),clock());return get(ticket.id);
 });
 const claim=sql.transaction(id=>{
  const row=get(id);if(!row||row.state!=='pending'||row.next_retry_at>clock()||row.lease_until>clock())return null;
  sql.prepare('UPDATE ticket_closure_delivery SET lease_until=? WHERE ticket_id=?').run(clock()+120000,id);return row;
 });
 return {get,enqueue,pending:id=>get(id)?.state==='pending',
  async process(apply,{ticketId=null}={}){
   const rows=ticketId?[{ticket_id:ticketId}]:sql.prepare("SELECT ticket_id FROM ticket_closure_delivery WHERE state='pending' AND next_retry_at<=? AND lease_until<=? ORDER BY created_at LIMIT 20").all(clock(),clock());
   let completed=0;
   for(const item of rows){const row=claim(item.ticket_id);if(!row)continue;
    try{
     const result=await apply(row);
     const state=result==='superseded'?'superseded':result===false?'pending':'done';
     sql.prepare('UPDATE ticket_closure_delivery SET state=?,lease_until=0,next_retry_at=?,last_error=NULL WHERE ticket_id=?').run(state,clock()+5000,row.ticket_id);
     if(state!=='pending')completed++;
    }catch(error){const retry=Math.min(900000,15000*2**Math.min(row.attempts,6));sql.prepare('UPDATE ticket_closure_delivery SET attempts=attempts+1,next_retry_at=?,lease_until=0,last_error=? WHERE ticket_id=?').run(clock()+retry,String(error.message||error).slice(0,300),row.ticket_id);}
   }
   return completed;
  },
  diagnostics(){return {pending:sql.prepare("SELECT COUNT(*) n FROM ticket_closure_delivery WHERE state='pending'").get().n,failed:sql.prepare("SELECT COUNT(*) n FROM ticket_closure_delivery WHERE state='pending' AND attempts>0").get().n};}
 };
}
module.exports={installTicketClosures,createTicketClosures};
