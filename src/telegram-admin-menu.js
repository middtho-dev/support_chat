'use strict';

// Rich controls live inside the panel; the same actions form its plain fallback.
function buildAdminMenu({name,counts={},webAppUrl=''}) {
  const n=key=>Math.max(0,Number(counts[key])||0);
  const rows=[
    [{text:`🔔 Новые · ${n('waiting')}`,callback_data:'list:waiting:0',...(n('waiting')?{style:'primary'}:{})},
      {text:`💬 Мои обращения · ${n('mine')}`,callback_data:'list:mine:0'}],
    [{text:`⏳ Ждут ответа · ${n('unanswered')}`,callback_data:'list:unanswered:0',...(n('unanswered')?{style:'primary'}:{})},
      {text:`✅ Закрытые · ${n('closed')}`,callback_data:'list:closed:0'}]
  ];
  const tools=[];
  if(webAppUrl)tools.push({text:'🖥 Веб-админка',web_app:{url:webAppUrl},style:'primary'});
  tools.push({text:'⚙️ Система и обслуживание',callback_data:'system:show'});
  const refresh=[{text:'Обновить',callback_data:'dashboard:refresh',style:'link'}];
  const blocks=[
    {type:'heading',size:2,text:'KV9RU · Поддержка'},
    {type:'paragraph',text:{type:'bold',text:String(name||'Оператор')}},
    {type:'paragraph',text:'Новые обращения и ваши диалоги — всё под рукой.'},
    {type:'heading',size:4,text:'Обращения'},
    ...rows.map(buttons=>({type:'buttons',buttons})),
    {type:'divider'},
    {type:'heading',size:4,text:'Инструменты'},
    {type:'buttons',buttons:tools},
    {type:'buttons',buttons:refresh},
    {type:'footer',text:'Выберите действие. Разделы открываются в этой панели.'}
  ];
  const fallbackRows=[...rows,tools,refresh].map(row=>row.map(button=>{
    const result={...button};if(result.style==='link')delete result.style;return result;
  }));
  const fallback=`KV9RU · Поддержка\n\n${name||'Оператор'}\n\nВыберите обращения или инструменты кнопками ниже.`;
  return {rich:{blocks},markdown:'## KV9RU · Поддержка\n\nВыберите действие кнопками ниже.',fallback,replyMarkup:{inline_keyboard:fallbackRows}};
}
module.exports={buildAdminMenu};
