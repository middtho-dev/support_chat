'use strict';

// Rich controls live inside the panel; the same actions form its plain fallback.
function buildAdminMenu({name,counts={},webAppUrl='',serverSummary='',shared=false}) {
  const n=key=>Math.max(0,Number(counts[key])||0);
  const rows=shared?[[{text:`💬 Общие обращения · ${n('mine')}`,callback_data:'list:mine:0'}],[{text:`⏳ Ждут ответа · ${n('unanswered')}`,callback_data:'list:unanswered:0'}]]:[
    [{text:`🔔 Новые · ${n('waiting')}`,callback_data:'list:waiting:0',...(n('waiting')?{style:'primary'}:{})},
      {text:`💬 Мои обращения · ${n('mine')}`,callback_data:'list:mine:0'}],
    [{text:`⏳ Ждут ответа · ${n('unanswered')}`,callback_data:'list:unanswered:0',...(n('unanswered')?{style:'primary'}:{})}]
  ];
  const tools=[];
  if(webAppUrl)tools.push({text:'🖥 Веб-админка',web_app:{url:webAppUrl},style:'primary'});
  tools.push({text:'⚙️ Система и обслуживание',callback_data:'system:show'});

  const blocks=[
    {type:'heading',size:2,text:'KV9RU · Поддержка'},
    {type:'paragraph',text:{type:'bold',text:String(name||'Оператор')}},
    ...rows.map(buttons=>({type:'buttons',buttons})),
    {type:'divider'},
    ...(serverSummary?[{type:'paragraph',text:serverSummary}]:[]),
    {type:'buttons',buttons:tools},
    {type:'footer',text:'Данные обновляются автоматически'}
  ];
  const fallbackRows=[...rows,tools].map(row=>row.map(button=>{
    const result={...button};if(result.style==='link')delete result.style;return result;
  }));
  const fallback=`KV9RU · Поддержка\n\n${name||'Оператор'}${serverSummary?'\n\n'+serverSummary:''}\n\nВыберите обращения или инструменты кнопками ниже.`;
  return {view:'home',rich:{blocks},markdown:'## KV9RU · Поддержка\n\nВыберите действие кнопками ниже.',fallback,replyMarkup:{inline_keyboard:fallbackRows}};
}
module.exports={buildAdminMenu};
