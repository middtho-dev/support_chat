'use strict';
const defaults={enabled:false,botToken:'',allowEveryone:true,allowedUsers:'',youtube:true,instagram:true,maxMB:45,maxSeconds:180,height:720,perHour:10,retentionMinutes:30};
function validate(input,previous=defaults){
 const c={...previous};
 for(const key of Object.keys(defaults))if(Object.hasOwn(input,key)){
  if(key==='botToken'&&input[key]==='')continue;
  if(typeof input[key]!==typeof defaults[key])throw Error('Некорректное поле: '+key);
  c[key]=typeof input[key]==='string'?input[key].trim():input[key];
 }
 for(const [key,min,max] of [['maxMB',5,48],['maxSeconds',15,600],['perHour',1,100],['retentionMinutes',10,180]])if(!Number.isInteger(c[key])||c[key]<min||c[key]>max)throw Error(`${key}: от ${min} до ${max}`);
 if(![360,480,720,1080].includes(c.height))throw Error('Недопустимое качество');
 if(c.botToken&&!/^\d+:[A-Za-z0-9_-]{20,}$/.test(c.botToken))throw Error('Некорректный токен бота');
 if(c.allowedUsers.length>4000||c.allowedUsers.split(/[\s,;]+/).filter(Boolean).some(x=>!/^\d{1,16}$/.test(x)))throw Error('Нужны числовые Telegram ID');
 if(c.enabled&&!c.botToken)throw Error('Сначала сохраните токен отдельного бота');
 if(!c.allowEveryone&&!c.allowedUsers.trim())throw Error('Укажите разрешённых пользователей');
 return c;
}
function videoUrl(value){
 let u;try{u=new URL(value);}catch{return null;}
 if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port)return null;
 const host=u.hostname.toLowerCase().replace(/^www\./,'');
 if(['youtube.com','m.youtube.com','youtu.be'].includes(host)){
  const id=host==='youtu.be'?u.pathname.slice(1).split('/')[0]:u.pathname.startsWith('/shorts/')?u.pathname.split('/')[2]:u.pathname==='/watch'?u.searchParams.get('v'):null;
  return /^[\w-]{11}$/.test(id||'')?{url:'https://www.youtube.com/watch?v='+id,source:'youtube'}:null;
 }
 if(host==='instagram.com'){
  const match=u.pathname.match(/^\/(reel|reels|p)\/([\w-]+)\/?$/);
  if(match)return {url:'https://www.instagram.com/'+(match[1]==='reels'?'reel':match[1])+'/'+match[2]+'/',source:'instagram'};
 }
 return null;
}
function extract(message){
 for(const m of [message,message.reply_to_message])if(m){
  const text=m.text||m.caption||'';
  const links=[...(text.match(/https?:\/\/[^\s<>]+/g)||[]),...(m.entities||m.caption_entities||[]).filter(e=>e.type==='text_link').map(e=>e.url)];
  for(const link of links){const result=videoUrl(link.replace(/[),.!?]+$/,''));if(result)return result;}
 }
 return null;
}
module.exports={defaults,validate,videoUrl,extract};
