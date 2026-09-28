'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const defaults={enabled:false,model:'gpt-5.5',effort:'high',dailyLimit:30,maxStorageMB:1024,batchChars:24000,maxDigestBatches:30,answerTokens:6000,instructions:'Пиши по-русски. Короткое резюме, затем полезные детали и выводы. Убирай повторы и разговорный шум. Не теряй важные имена, даты и ссылки.',emoji:true};
class Store{
 constructor(dir,key,Database=require('better-sqlite3')){
  if(!/^[a-f0-9]{64}$/i.test(key||''))throw Error('Нужен KNOWLEDGE_ENCRYPTION_KEY');
  this.key=Buffer.from(key,'hex');fs.mkdirSync(dir,{recursive:true,mode:0o700});this.dir=dir;this.file=path.join(dir,'settings.json');
  this.state=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):{config:{},secrets:{},ownerId:'',account:''};
  this.state.config={...defaults,...this.state.config};this.state.secrets=this.state.secrets?.iv?JSON.parse(this.decrypt(this.state.secrets)):{};
  this.db=new Database(path.join(dir,'knowledge.db'));this.db.pragma('journal_mode = WAL');this.db.pragma('foreign_keys = ON');
  this.db.exec(`CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,title TEXT NOT NULL,username TEXT,peer TEXT NOT NULL,selected INTEGER DEFAULT 0,cursor INTEGER DEFAULT 0,latest INTEGER DEFAULT 0,complete INTEGER DEFAULT 0,next_at INTEGER DEFAULT 0,error TEXT DEFAULT '',updated INTEGER DEFAULT 0);
   CREATE TABLE IF NOT EXISTS messages(chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,id INTEGER NOT NULL,date INTEGER NOT NULL,sender TEXT,body TEXT NOT NULL,reply_id INTEGER,PRIMARY KEY(chat_id,id));
   CREATE INDEX IF NOT EXISTS messages_date ON messages(date);
   CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(body,content='messages',content_rowid='rowid',tokenize='unicode61');
   CREATE TRIGGER IF NOT EXISTS msg_ai AFTER INSERT ON messages BEGIN INSERT INTO search(rowid,body) VALUES(new.rowid,new.body); END;
   CREATE TRIGGER IF NOT EXISTS msg_ad AFTER DELETE ON messages BEGIN INSERT INTO search(search,rowid,body) VALUES('delete',old.rowid,old.body); END;
   CREATE TRIGGER IF NOT EXISTS msg_au AFTER UPDATE ON messages BEGIN INSERT INTO search(search,rowid,body) VALUES('delete',old.rowid,old.body); INSERT INTO search(rowid,body) VALUES(new.rowid,new.body); END;
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source TEXT NOT NULL,kind TEXT NOT NULL,query TEXT,chat_id TEXT,status TEXT NOT NULL,created INTEGER NOT NULL,result TEXT DEFAULT '',error TEXT DEFAULT '',usage INTEGER DEFAULT 0,reply_to INTEGER,progress TEXT DEFAULT '',bot_message INTEGER);
   CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created);`);
  this.db.prepare("UPDATE jobs SET status='failed',error='Обработка прервана перезапуском. Повторите запрос.' WHERE status IN ('running','sending')").run();
  this.save();
 }
 encrypt(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',this.key,iv);return{iv:iv.toString('hex'),data:Buffer.concat([c.update(text,'utf8'),c.final()]).toString('base64'),tag:c.getAuthTag().toString('hex')};}
 decrypt(v){const d=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.iv,'hex'));d.setAuthTag(Buffer.from(v.tag,'hex'));return Buffer.concat([d.update(Buffer.from(v.data,'base64')),d.final()]).toString('utf8');}
 save(){fs.writeFileSync(this.file+'.tmp',JSON.stringify({...this.state,secrets:this.encrypt(JSON.stringify(this.state.secrets))}),{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}
 chats(){return this.db.prepare('SELECT c.id,c.title,c.username,c.selected,c.complete,c.error,c.updated,c.next_at,COUNT(m.id) AS messages,MIN(m.date) AS oldest,MAX(m.date) AS newest FROM chats c LEFT JOIN messages m ON m.chat_id=c.id GROUP BY c.id ORDER BY c.selected DESC,c.title').all();}
 putChat(c){this.db.prepare('INSERT INTO chats(id,title,username,peer) VALUES(@id,@title,@username,@peer) ON CONFLICT(id) DO UPDATE SET title=excluded.title,username=excluded.username,peer=excluded.peer').run(c);}
 putMessages(chatId,messages){const stmt=this.db.prepare('INSERT INTO messages(chat_id,id,date,sender,body,reply_id) VALUES(@chat_id,@id,@date,@sender,@body,@reply_id) ON CONFLICT(chat_id,id) DO UPDATE SET body=excluded.body,sender=excluded.sender,reply_id=excluded.reply_id');this.db.transaction(()=>{for(const m of messages){if(m.body?.trim())stmt.run({chat_id:chatId,id:m.id,date:m.date,sender:m.sender||'',body:m.body,reply_id:m.reply_id||null});else this.db.prepare('DELETE FROM messages WHERE chat_id=? AND id=?').run(chatId,m.id);}})();}
 select(id,selected){if(!this.db.prepare('SELECT id FROM chats WHERE id=?').get(id))throw Error('Чат не найден');this.db.prepare("UPDATE chats SET selected=?,error='',next_at=0 WHERE id=?").run(selected?1:0,id);}
 purge(id){this.db.transaction(()=>{this.db.prepare('DELETE FROM messages WHERE chat_id=?').run(id);this.db.prepare("UPDATE chats SET selected=0,cursor=0,latest=0,complete=0,error='' WHERE id=?").run(id);this.db.prepare('DELETE FROM jobs').run();})();this.db.pragma('wal_checkpoint(TRUNCATE)');}
 search(query,chatId='',limit=60){
  const tokens=[...new Set((query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[]).filter(w=>!new Set(['как','что','где','когда','это','для','или','the','and','какие','было','найди','расскажи','про']).has(w)))].slice(0,18);
  if(!tokens.length)return[];const match=tokens.map(w=>'"'+w+'"*').join(' OR ');
  return this.db.prepare(`SELECT m.*,c.title,c.username FROM search s JOIN messages m ON m.rowid=s.rowid JOIN chats c ON c.id=m.chat_id WHERE search MATCH ? AND c.selected=1 ${chatId?'AND c.id=?':''} ORDER BY bm25(search) LIMIT ?`).all(...[match,...(chatId?[chatId]:[]),limit]);
 }
 period(since,chatId='',limit=30001,until=Date.now()){return this.db.prepare(`SELECT m.*,c.title,c.username FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.selected=1 AND m.date>=? AND m.date<=? ${chatId?'AND c.id=?':''} ORDER BY m.date,m.id LIMIT ?`).all(since,until,...(chatId?[chatId]:[]),limit);}
 bytes(){return ['knowledge.db','knowledge.db-wal'].reduce((n,f)=>n+(fs.existsSync(path.join(this.dir,f))?fs.statSync(path.join(this.dir,f)).size:0),0);}
 status(){const {config,ownerId,account,secrets}=this.state;return{config,ownerId,account,hasApi:!!secrets.apiHash,apiId:secrets.apiId||'',hasKey:!!(secrets.openaiKey||process.env.OPENAI_API_KEY),hasSession:!!secrets.session,chats:this.chats(),bytes:this.bytes(),jobs:this.db.prepare('SELECT * FROM jobs ORDER BY created DESC LIMIT 20').all()};}
}
function validate(c){if(typeof c.enabled!=='boolean'||typeof c.emoji!=='boolean')throw Error('Неверный переключатель');if(!/^[\w.-]{1,80}$/.test(c.model)||!['low','medium','high'].includes(c.effort))throw Error('Неверная модель или глубина');for(const[k,min,max]of [['dailyLimit',1,500],['maxStorageMB',128,10240],['batchChars',8000,50000],['maxDigestBatches',1,100],['answerTokens',1000,16000]])if(!Number.isInteger(c[k])||c[k]<min||c[k]>max)throw Error(`${k}: от ${min} до ${max}`);if(typeof c.instructions!=='string'||c.instructions.length>4000)throw Error('Инструкция: до 4000 символов');}
module.exports={Store,defaults,validate};
