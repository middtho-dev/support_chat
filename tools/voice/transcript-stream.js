'use strict';
async function readTranscript(response, onText) {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const result=await response.json();
    if(!result.text?.trim())throw Error('Речь не распознана');
    return result.text.trim();
  }
  const decoder=new TextDecoder();let buffer='',text='',complete=false;
  const event=async frame=>{
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data||data==='[DONE]')return;
    const value=JSON.parse(data);
    if(value.type==='error')throw Error('Ошибка потокового распознавания');
    if(value.type==='transcript.text.delta'){text+=value.delta||'';await onText(text);}
    if(value.type==='transcript.text.done'){text=value.text??text;complete=true;}
  };
  for await(const chunk of response.body){
    buffer+=decoder.decode(chunk,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');
    let boundary;while((boundary=buffer.indexOf('\n\n'))>=0){await event(buffer.slice(0,boundary));buffer=buffer.slice(boundary+2);}
    if(buffer.length>1024*1024||text.length>200000)throw Error('Слишком большой ответ распознавания');
  }
  buffer+=decoder.decode();if(buffer.trim())await event(buffer);
  if(!complete||!text.trim())throw Error('Поток распознавания прерван до завершения');
  return text.trim();
}
module.exports={readTranscript};
