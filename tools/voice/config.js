'use strict';
const defaults = {enabled:false,botToken:'',openaiKey:'',ownerIds:'',direction:'incoming',voice:true,videoNote:false,audio:false,chatMode:'all',chatIds:'',excludeChatIds:'',minSeconds:1,maxSeconds:300,dailyMinutes:60,language:'',transcribeModel:'gpt-4o-mini-transcribe',formatModel:'gpt-4.1-mini',polish:true,style:'readable',emoji:false,instructions:'',prefix:'Расшифровка:',deleteOriginal:false,silent:true,retentionHours:24};
function ids(value) { return String(value).split(/[\s,;]+/).filter(Boolean); }
function validate(input, previous=defaults) {
  const c={...previous};
  for(const key of Object.keys(defaults)) if(Object.hasOwn(input,key)) {
    if(['botToken','openaiKey'].includes(key) && input[key]==='') continue;
    if(typeof defaults[key]==='boolean') {if(typeof input[key]!=='boolean') throw Error('Некорректный переключатель: '+key);c[key]=input[key];}
    else if(typeof defaults[key]==='number') {c[key]=Number(input[key]);if(!Number.isInteger(c[key]))throw Error('Нужно целое число: '+key);}
    else {if(typeof input[key]!=='string')throw Error('Нужен текст: '+key);c[key]=input[key].trim();}
  }
  for(const [key,min,max] of [['minSeconds',0,1200],['maxSeconds',1,1200],['dailyMinutes',1,1440],['retentionHours',1,168]])if(c[key]<min||c[key]>max)throw Error(`${key}: от ${min} до ${max}`);
  if(c.minSeconds>c.maxSeconds)throw Error('Минимальная длительность больше максимальной');
  for(const key of ['ownerIds','chatIds','excludeChatIds'])if(c[key].length>4000||ids(c[key]).some(x=>! /^-?\d{1,16}$/.test(x)))throw Error('Введите числовые Telegram ID: '+key);
  for(const [key,values] of [['direction',['incoming','outgoing','both']],['chatMode',['all','allow']],['style',['readable','verbatim','concise']]])if(!values.includes(c[key]))throw Error('Недопустимое значение: '+key);
  if(c.chatMode==='allow'&&!ids(c.chatIds).length)throw Error('Укажите разрешённые чаты');
  if(c.language&&!/^[a-z]{2,3}$/.test(c.language))throw Error('Язык: ru, en или пустое поле');
  for(const key of ['transcribeModel','formatModel'])if(!/^[a-zA-Z0-9._:-]{1,100}$/.test(c[key]))throw Error('Некорректная модель');
  if(c.instructions.length>2000||c.prefix.length>200)throw Error('Слишком длинный текст');
  if(c.botToken&&!/^\d+:[A-Za-z0-9_-]{20,}$/.test(c.botToken))throw Error('Некорректный токен Telegram');
  if(c.openaiKey.length>512||/[\r\n]/.test(c.openaiKey))throw Error('Некорректный ключ OpenAI');
  if(c.enabled&&(!c.botToken||!c.openaiKey||!ids(c.ownerIds).length))throw Error('Для запуска нужны оба ключа и ID владельца аккаунта');
  return c;
}
function selectMessage(c, connection, m) {
  if(!c.enabled||!connection?.is_enabled||!ids(c.ownerIds).includes(String(connection.user?.id)))return null;
  if(!connection.rights?.can_reply||m.chat?.type!=='private'||m.sender_business_bot||m.from?.is_bot)return null;
  const chat=String(m.chat.id),outgoing=String(m.from?.id)===String(connection.user.id);
  if(c.direction!=='both'&&(outgoing?'outgoing':'incoming')!==c.direction)return null;
  if(ids(c.excludeChatIds).includes(chat)||(c.chatMode==='allow'&&!ids(c.chatIds).includes(chat)))return null;
  const media=c.voice&&m.voice||c.videoNote&&m.video_note||c.audio&&m.audio;
  if(!media||!Number.isFinite(media.duration)||media.duration<c.minSeconds||media.duration>c.maxSeconds||media.file_size>20*1024*1024)return null;
  return {fileId:media.file_id,seconds:Math.ceil(media.duration),senderId:m.from?.id,kind:m.voice?'voice':m.video_note?'video_note':'audio',chatId:m.chat.id,messageId:m.message_id,connectionId:m.business_connection_id};
}
module.exports={defaults,validate,ids,selectMessage};
