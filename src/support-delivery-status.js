'use strict';
function supportDeliveryStatus({source,online=false,pending=0,total=0,failed=0,waitingForOperator=false}) {
  const lines=[];
  if(source!=='telegram')lines.push(online?'🟢 Клиент в чате':'🔴 Клиент не в чате');
  if(waitingForOperator)lines.push('🔔 Клиент ждёт вашего ответа');
  if(pending>0){
    lines.push(source==='telegram'?`📤 В очереди отправки: ${pending}`:`📨 Ещё не получено клиентом: ${pending}`);
    if(failed>0)lines.push('⚠️ Не удалось отправить — повторяем доставку');
    else if(source!=='telegram')lines.push(online?'Ждём подтверждения от чата клиента':'Ответы сохранены. Клиент получит их, когда откроет чат');
  }else if(total>0)lines.push(source==='telegram'?'✅ Все ответы отправлены в Telegram':'✅ Все ответы получены клиентом');
  else if(!waitingForOperator)lines.push('Пока нет ответов поддержки');
  return lines.join('\n');
}
module.exports={supportDeliveryStatus};
