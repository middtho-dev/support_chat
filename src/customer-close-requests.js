'use strict';
const CLOSE_DELAY_MS=5*60*1000;
function installCloseRequests(sql){
 sql.exec(`CREATE TABLE IF NOT EXISTS customer_close_requests (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL, user_sequence INTEGER NOT NULL, deadline INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
 );
 CREATE INDEX IF NOT EXISTS idx_customer_close_due ON customer_close_requests(state,deadline);
 CREATE TRIGGER IF NOT EXISTS cancel_customer_close_on_message AFTER INSERT ON messages
 WHEN NEW.sender='user' BEGIN
  UPDATE customer_close_requests SET state='cancelled' WHERE ticket_id=NEW.ticket_id AND state='pending';
 END;
 CREATE TRIGGER IF NOT EXISTS cancel_customer_close_on_ticket_close AFTER UPDATE OF status ON tickets
 WHEN NEW.status='closed' BEGIN
  UPDATE customer_close_requests SET state='cancelled' WHERE ticket_id=NEW.id AND state='pending';
 END;`);
 const columns=sql.prepare('PRAGMA table_info(customer_close_requests)').all();
 for(const name of ['lease_until','retry_at'])if(!columns.some(c=>c.name===name))sql.exec('ALTER TABLE customer_close_requests ADD COLUMN '+name+' INTEGER NOT NULL DEFAULT 0');
}
function createCustomerCloseRequests(sql,{clock=Date.now}={}){
 const get=id=>sql.prepare('SELECT * FROM customer_close_requests WHERE ticket_id=?').get(id);
 const sequence=id=>sql.prepare("SELECT COALESCE(MAX(rowid),0) n FROM messages WHERE ticket_id=? AND sender='user'").get(id).n;
 const arm=sql.transaction((ticketId,promptId,baseline)=>{
  const ticket=sql.prepare('SELECT status FROM tickets WHERE id=?').get(ticketId);
  if(ticket?.status!=='open')return null;
  const state=sequence(ticketId)===baseline?'pending':'cancelled';
  sql.prepare(`INSERT INTO customer_close_requests(ticket_id,prompt_id,user_sequence,deadline,state) VALUES (?,?,?,?,?)
   ON CONFLICT(ticket_id) DO UPDATE SET prompt_id=excluded.prompt_id,user_sequence=excluded.user_sequence,deadline=excluded.deadline,state=excluded.state,lease_until=0,retry_at=0`)
   .run(ticketId,promptId,baseline,clock()+CLOSE_DELAY_MS,state);
  return get(ticketId);
 });
 const claim=sql.transaction(ticketId=>{
  const row=get(ticketId),ticket=sql.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  if(!row||row.retry_at>clock()||row.lease_until>clock())return null;
  if(row.state==='closing'&&ticket?.status==='closed'){sql.prepare('UPDATE customer_close_requests SET lease_until=? WHERE ticket_id=?').run(clock()+60000,ticketId);return ticket;}
  if(row.state!=='pending'||row.deadline>clock()||ticket?.status!=='open')return null;
  if(sequence(ticketId)!==row.user_sequence){sql.prepare("UPDATE customer_close_requests SET state='cancelled' WHERE ticket_id=?").run(ticketId);return null;}
  sql.prepare("UPDATE tickets SET status='closed',closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(ticketId);
  sql.prepare("UPDATE customer_close_requests SET state='closing',lease_until=? WHERE ticket_id=?").run(clock()+60000,ticketId);
  return {...ticket,status:'closed'};
 });
 let running=false;
 return {get,sequence,arm,
  pending(id){const row=get(id);return row?.state==='pending'?row:null;},
  async process(onClosed){
   if(running)return 0;running=true;let count=0;
   try{
    const rows=sql.prepare("SELECT ticket_id FROM customer_close_requests WHERE (state='pending' AND deadline<=? OR state='closing') AND retry_at<=? AND lease_until<=? ORDER BY deadline LIMIT 50").all(clock(),clock(),clock());
    for(const row of rows){const ticket=claim(row.ticket_id);if(!ticket)continue;count++;
     try{await onClosed(ticket);sql.prepare("UPDATE customer_close_requests SET state='closed',lease_until=0 WHERE ticket_id=?").run(ticket.id);}
     catch(error){sql.prepare('UPDATE customer_close_requests SET lease_until=0,retry_at=? WHERE ticket_id=?').run(clock()+15000,ticket.id);throw error;}
    }
    return count;
   }finally{running=false;}
  }
 };
}
module.exports={CLOSE_DELAY_MS,installCloseRequests,createCustomerCloseRequests};
