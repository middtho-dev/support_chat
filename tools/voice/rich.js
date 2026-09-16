'use strict';
const defaults={richBody:'paragraph',richTitleStyle:'bold',richBold:false,richItalic:false,richUnderline:false,richStrike:false,richHighlight:false,richSpoiler:false,richParagraphs:true,richDivider:false,richFooter:'',richCollapse:false,richSummary:'Расшифровка',richExpanded:false,richAutoLinks:true,richRtl:false,richProtect:false,richUpdateMs:1200,richChunkChars:1800};
const keys=[...Object.keys(defaults),'richMessages','prefix'];
const escape=text=>String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function validate(c){
 if(!['paragraph','quote','pre','footer','h5','h6'].includes(c.richBody))throw Error('Недопустимый стиль Rich-текста');
 if(!['plain','bold','hidden','h1','h2','h3','h4','h5','h6'].includes(c.richTitleStyle))throw Error('Недопустимый стиль заголовка Rich');
 if(c.richFooter.length>400||c.richSummary.length>100||(c.richCollapse&&!c.richSummary.trim()))throw Error('Подпись: до 400 символов; название спойлера: 1–100');
 if(!Number.isInteger(c.richUpdateMs)||c.richUpdateMs<1000||c.richUpdateMs>5000)throw Error('Обновление Rich: 1000–5000 мс');
 if(!Number.isInteger(c.richChunkChars)||c.richChunkChars<500||c.richChunkChars>3500)throw Error('Длина части: 500–3500 символов');
}
function render(text,options={}){
 const c={...defaults,...options};validate(c);
 let body=String(text),title='';
 if(c.prefix&&body.startsWith(c.prefix+'\n')){title=c.prefix;body=body.slice(c.prefix.length+1);}
 let header='';
 if(title&&c.richTitleStyle!=='hidden'){
  const tag=/^h[1-6]$/.test(c.richTitleStyle)?c.richTitleStyle:'p';
  header='<'+tag+'>'+(c.richTitleStyle==='bold'?'<b>'+escape(title)+'</b>':escape(title))+'</'+tag+'>';
 }
 const inline=value=>{
  let result=escape(value).replace(/\n/g,'<br>');
  for(const [key,tag]of [['richBold','b'],['richItalic','i'],['richUnderline','u'],['richStrike','s'],['richHighlight','mark'],['richSpoiler','tg-spoiler']])if(c[key])result='<'+tag+'>'+result+'</'+tag+'>';
  return result;
 };
 let content;
 if(c.richBody==='pre')content='<pre>'+escape(body)+'</pre>';
 else{
  const tag=({paragraph:'p',quote:'p',footer:'footer',h5:'h5',h6:'h6'})[c.richBody];
  content=(c.richParagraphs?body.split(/\n\s*\n/):[body]).map(p=>'<'+tag+'>'+inline(p)+'</'+tag+'>').join('');
  if(c.richBody==='quote')content='<blockquote>'+content+'</blockquote>';
 }
 if(c.richCollapse)content='<details'+(c.richExpanded?' open':'')+'><summary>'+escape(c.richSummary)+'</summary>'+content+'</details>';
 return {html:header+(header&&c.richDivider?'<hr>':'')+content+(c.richFooter?'<footer>'+escape(c.richFooter).replace(/\n/g,'<br>')+'</footer>':''),is_rtl:c.richRtl,skip_entity_detection:!c.richAutoLinks};
}
module.exports={defaults,keys,validate,render};
