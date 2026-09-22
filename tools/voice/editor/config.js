'use strict';
const defaults={enabled:false,ownerIds:'',style:'readable',paragraphs:true,lists:true,bold:true,emoji:true,emojiPlacement:'inline',emojiDensity:'moderate',instructions:'',model:'gpt-4.1-mini',minLength:20,excludeChatIds:'',chatIds:'',chatMode:'all',dailyLimit:300};
const ids=v=>String(v).split(/[\s,;]+/).filter(Boolean);
function validate(input,previous=defaults){
 const c={...defaults,...previous};
 for(const k of Object.keys(defaults))if(Object.hasOwn(input,k)){
  if(typeof input[k]!==typeof defaults[k])throw Error('Некорректное поле: '+k);
  c[k]=typeof input[k]==='string'?input[k].trim():input[k];
 }
 for(const k of ['ownerIds','excludeChatIds','chatIds'])if(c[k].length>4000||ids(c[k]).some(id=>! /^-?\d{1,16}$/.test(id)))throw Error('Нужны числовые Telegram ID');
 if(ids(c.ownerIds).some(id=>id.startsWith('-')))throw Error('ID аккаунта должен быть положительным');
 for(const [k,values]of [['style',['correct','readable','concise','instruction']],['emojiPlacement',['inline','paragraph']],['emojiDensity',['sparse','moderate','expressive']],['chatMode',['all','allow']]])if(!values.includes(c[k]))throw Error('Недопустимое значение: '+k);
 if(!Number.isInteger(c.minLength)||c.minLength<1||c.minLength>1000||!Number.isInteger(c.dailyLimit)||c.dailyLimit<1||c.dailyLimit>3000)throw Error('Минимум: 1–1000 символов; лимит: 1–3000 сообщений');
 if(c.instructions.length>2000||! /^[a-zA-Z0-9._:-]{1,100}$/.test(c.model))throw Error('Некорректная модель или слишком длинная инструкция');
 if(c.enabled&&!ids(c.ownerIds).length)throw Error('Выберите хотя бы один аккаунт');
 if(c.chatMode==='allow'&&!ids(c.chatIds).length)throw Error('Укажите разрешённые чаты');
 return c;
}
function eligible(c,conn,m){
 return !!(c.enabled&&conn?.is_enabled&&conn.rights?.can_reply&&ids(c.ownerIds).includes(String(conn.user?.id))&&m.from?.id===conn.user?.id&&!m.from?.is_bot&&!m.sender_business_bot&&!m.forward_origin&&m.chat?.type==='private'&&typeof m.text==='string'&&m.text.trim().length>=c.minLength&&m.text.length<=4096&&!m.text.startsWith('/')&&!ids(c.excludeChatIds).includes(String(m.chat.id))&&(c.chatMode!=='allow'||ids(c.chatIds).includes(String(m.chat.id))));
}
module.exports={defaults,validate,eligible,ids};
