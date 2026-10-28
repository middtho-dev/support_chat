'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {createLivePanels}=require('../src/telegram-live-panels');
test('live panel selection, deadline, confirmation pause and digest survive manager restart',()=>{
 const sql=new Database(':memory:');let now=1000;
 try{
  sql.exec("CREATE TABLE telegram_operators (telegram_user_id TEXT PRIMARY KEY,active INTEGER,dashboard_message_id INTEGER); INSERT INTO telegram_operators VALUES ('1',1,10),('2',0,20)");
  let panels=createLivePanels(sql,{clock:()=>now});
  const model={view:'list:mine',page:2,rich:{blocks:[{type:'buttons',buttons:[{text:'История',web_app:{url:'https://example.test/?v=one&ticket=x'}}]}]}};
  panels.rendered('1',model,10);assert.equal(panels.get('1').page,2);assert.equal(panels.due().length,0);
  const refreshed=JSON.parse(JSON.stringify(model));refreshed.rich.blocks[0].buttons[0].web_app.url='https://example.test/?v=two&ticket=x';
  assert.equal(panels.unchanged('1',refreshed,10),true);assert.equal(panels.unchanged('1',model,11),false);
  now+=15000;panels=createLivePanels(sql,{clock:()=>now});assert.equal(panels.due()[0].view,'list:mine');
  panels.select('1',{view:'confirm-clear',pauseUntil:now+60000});assert.equal(panels.due().length,0);
  now+=60001;assert.equal(panels.due().length,1);panels.failed('1',30000);assert.equal(panels.due().length,0);
  panels.rendered('2',model,20);now+=40000;assert.deepEqual(panels.due().map(r=>r.operator_id),['1']);
 }finally{sql.close();}
});
