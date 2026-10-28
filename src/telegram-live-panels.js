'use strict';
const crypto=require('node:crypto');
function createLivePanels(sql,{clock=Date.now}={}) {
 sql.exec(`CREATE TABLE IF NOT EXISTS telegram_operator_panel_views (
  operator_id TEXT PRIMARY KEY REFERENCES telegram_operators(telegram_user_id) ON DELETE CASCADE,
  view TEXT NOT NULL DEFAULT 'home',page INTEGER NOT NULL DEFAULT 0,pause_until INTEGER NOT NULL DEFAULT 0,
  digest TEXT,message_id INTEGER,next_refresh INTEGER NOT NULL DEFAULT 0
 )`);
 const get=id=>sql.prepare('SELECT * FROM telegram_operator_panel_views WHERE operator_id=?').get(String(id));
 const fingerprint=model=>crypto.createHash('sha256').update(JSON.stringify({body:model.rich||model.markdown,keyboard:model.rich?null:model.replyMarkup},(key,value)=>{
  if(key==='web_app'&&value?.url){try{const url=new URL(value.url);url.searchParams.delete('v');return {url:url.toString()};}catch(_){}}
  return value;
 })).digest('hex');
 return {
  get,
  select(id,model){
   if(!model.view)return;
   sql.prepare(`INSERT INTO telegram_operator_panel_views(operator_id,view,page,pause_until) VALUES (?,?,?,?)
    ON CONFLICT(operator_id) DO UPDATE SET view=excluded.view,page=excluded.page,pause_until=excluded.pause_until`)
    .run(String(id),model.view,model.page||0,model.pauseUntil||0);
  },
  unchanged(id,model,messageId){const row=get(id);return !!row&&row.message_id===messageId&&row.digest===fingerprint(model);},
  rendered(id,model,messageId){this.select(id,model);sql.prepare('UPDATE telegram_operator_panel_views SET digest=?,message_id=?,next_refresh=? WHERE operator_id=?').run(fingerprint(model),messageId,clock()+15000,String(id));},
  failed(id,delay){sql.prepare('UPDATE telegram_operator_panel_views SET next_refresh=? WHERE operator_id=?').run(clock()+delay,String(id));},
  due(){return sql.prepare(`SELECT v.* FROM telegram_operator_panel_views v JOIN telegram_operators op ON op.telegram_user_id=v.operator_id
    WHERE op.active=1 AND op.dashboard_message_id IS NOT NULL AND v.next_refresh<=? AND v.pause_until<=? ORDER BY v.next_refresh,v.operator_id LIMIT 30`).all(clock(),clock());}
 };
}
module.exports={createLivePanels};
