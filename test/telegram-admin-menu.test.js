'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildAdminMenu}=require('../src/telegram-admin-menu');
const buttons=model=>model.rich.blocks.filter(b=>b.type==='buttons').flatMap(b=>b.buttons);
test('native Rich menu embeds all navigation controls without home-screen cleanup',()=>{
 const menu=buildAdminMenu({name:'Имя <>&',counts:{waiting:3,mine:7,unanswered:2,closed:10},webAppUrl:'https://example.test/miniapp'});
 assert.deepEqual(Object.keys(menu.rich),['blocks']);
 assert.ok(menu.rich.blocks.some(b=>b.type==='paragraph'&&b.text?.text==='Имя <>&'));
 const controls=buttons(menu);assert.equal(controls.find(b=>b.callback_data==='list:waiting:0').text,'🔔 Новые · 3');
 assert.equal(controls.find(b=>b.callback_data==='list:unanswered:0').text,'⏳ Ждут ответа · 2');
 assert.ok(controls.some(b=>b.web_app?.url==='https://example.test/miniapp'));
 assert.ok(!controls.some(b=>b.callback_data?.startsWith('dashboard:clear')));
 assert.deepEqual(new Set(menu.replyMarkup.inline_keyboard.flat().map(b=>b.callback_data||b.web_app?.url)),new Set(controls.map(b=>b.callback_data||b.web_app?.url)));
 for(const b of menu.replyMarkup.inline_keyboard.flat())assert.notEqual(b.style,'link');
});
test('absent web URL and empty counts produce usable menu without broken links',()=>{
 const menu=buildAdminMenu({counts:{waiting:null,mine:-1}});assert.ok(!buttons(menu).some(b=>b.web_app));
 assert.ok(buttons(menu).some(b=>b.callback_data==='system:show'));
 assert.ok(buttons(menu).filter(b=>b.callback_data?.startsWith('list:')).every(b=>b.text.endsWith('· 0')));
 for(const row of menu.rich.blocks.filter(b=>b.type==='buttons')){assert.ok(row.buttons.length<=8);for(const b of row.buttons)if(b.callback_data)assert.ok(Buffer.byteLength(b.callback_data)<=64);}
});

test('shared menu presents the common queue without take-ownership actions',()=>{
 const controls=buttons(buildAdminMenu({shared:true,counts:{mine:5,unanswered:2}}));
 assert.ok(controls.some(b=>b.callback_data==='list:mine:0'&&b.text==='💬 Общие обращения · 5'));
 assert.ok(!controls.some(b=>b.callback_data==='list:waiting:0'));
});
