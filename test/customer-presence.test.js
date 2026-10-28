const test=require('node:test'),assert=require('node:assert/strict');
const {createCustomerPresence}=require('../src/customer-presence');
test('visibility heartbeat changes presence once and expires after network loss',()=>{
 let now=1000;const changes=[];const p=createCustomerPresence({clock:()=>now,onChange:(...v)=>changes.push(v)});
 p.report('ticket','tab-12345',true);assert.equal(p.online('ticket'),true);p.report('ticket','tab-12345',true);assert.equal(changes.length,1);
 now+=35001;p.sweep();assert.equal(p.online('ticket'),false);assert.deepEqual(changes,[['ticket',true],['ticket',false]]);p.sweep();assert.equal(changes.length,2);
});
test('hidden tab cannot turn another visible tab offline; malformed payloads rejected',()=>{
 const p=createCustomerPresence();p.report('t','tab-11111',true);p.report('t','tab-22222',true);p.report('t','tab-11111',false);assert.equal(p.online('t'),true);
 p.report('t','tab-22222',false);assert.equal(p.online('t'),false);assert.equal(p.report('t','bad',true),false);assert.equal(p.report('t','tab-11111','true'),false);
});
const {supportDeliveryStatus}=require('../src/support-delivery-status');
test('web status counts all unreceived answers without claiming that they were read',()=>{
 const offline=supportDeliveryStatus({source:'web',online:false,pending:3,total:5});assert.match(offline,/🔴 Клиент не в чате/);assert.match(offline,/Ещё не получено клиентом: 3/);assert.match(offline,/Ответы сохранены/);assert.doesNotMatch(offline,/прочитан/i);
 const online=supportDeliveryStatus({source:'web',online:true,pending:1,total:2});assert.match(online,/🟢 Клиент в чате/);assert.match(online,/подтверждения/);
 assert.match(supportDeliveryStatus({source:'web',online:true,total:2}),/Все ответы получены/);
});
test('Telegram status distinguishes send failure from reading and does not invent presence',()=>{
 const text=supportDeliveryStatus({source:'telegram',pending:2,total:3,failed:1});assert.match(text,/В очереди отправки: 2/);assert.match(text,/повторяем/);assert.doesNotMatch(text,/в чате|прочитан/i);
 assert.match(supportDeliveryStatus({source:'telegram',total:3}),/отправлены в Telegram/);
 assert.match(supportDeliveryStatus({source:'web',pending:2,total:2,waitingForOperator:true}),/Клиент ждёт вашего ответа/);
});
