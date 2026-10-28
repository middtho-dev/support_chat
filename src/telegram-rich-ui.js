'use strict';
const paragraph=text=>({type:'paragraph',text});
const heading=(text,size=3)=>({type:'heading',size,text});
const divider=()=>({type:'divider'});
function richPanel({blocks=[],rows=[],markdown='',fallback='',view,page=0,pauseUntil=0}) {
 const controls=rows.filter(row=>row.length).map(row=>({type:'buttons',buttons:row.map(button=>{
  const result={...button};delete result.icon_custom_emoji_id;return result;
 })}));
 return {rich:{blocks:[...blocks,...(controls.length?[divider(),...controls]:[])]},markdown,fallback,
  replyMarkup:{inline_keyboard:rows},view,page,pauseUntil};
}
module.exports={paragraph,heading,divider,richPanel};
