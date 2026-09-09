'use strict';
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
module.exports.createFirmwareProxy=function({authorize,serviceUrl=process.env.FIRMWARE_SERVICE_URL||'http://127.0.0.1:7700',serviceToken=process.env.FIRMWARE_SERVICE_TOKEN,frpUrl=process.env.FRP_SERVICE_URL||'http://127.0.0.1:7400',frpToken=process.env.FRP_SERVICE_TOKEN,publicUrl=process.env.PUBLIC_URL}={}){
 return async(req,res)=>{
  res.set('Cache-Control','no-store');const access=authorize(req.get('x-admin-token'));
  if(!access.authenticated)return res.status(401).json({error:'Требуется вход в панель'});
  if(!access.canManageSettings)return res.status(403).json({error:'Нет прав на сборку прошивки'});
  const suffix=req.path==='/'?'/':req.path;
  if(!((req.method==='GET'&&(suffix==='/'||/^\/jobs\/[a-f0-9]{32}\/download$/.test(suffix)))||(req.method==='POST'&&['/images','/jobs'].includes(suffix))||(req.method==='DELETE'&&/^\/(images|jobs)\/[a-f0-9]{32}$/.test(suffix))))return res.status(404).json({error:'Неизвестная операция'});
  if(!serviceToken)return res.status(503).json({error:'Сервис подготовки прошивки не настроен'});
  try{
   const headers={'x-admin-token':serviceToken};let body;
   if(req.method==='POST'&&suffix==='/images'){
    const size=Number(req.get('content-length'));
    if(req.get('content-type')!=='application/octet-stream'||!Number.isInteger(size)||size<1||size>64*1024*1024)return res.status(413).json({error:'Нужен .bin не более 64 МиБ'});
    headers['Content-Type']='application/octet-stream';headers['Content-Length']=String(size);
    let bytes=0;body=req.pipe(new Transform({transform(chunk,encoding,done){bytes+=chunk.length;done(bytes>size?new Error('Upload limit'):null,chunk);}}));
   }else if(req.method==='POST'){
    const input={...req.body};delete input.enrollment;
    if(input.frpc===true){
     if(!frpToken||!publicUrl)return res.status(503).json({error:'Не настроены FRP и публичный адрес панели'});
     const response=await fetch(new URL('/api/admin/frp/issue-firmware',frpUrl),{method:'POST',headers:{'x-admin-token':frpToken,'Content-Type':'application/json'},body:JSON.stringify({name:input.name,localIP:input.localIP,localPort:input.localPort,enrollmentUrl:new URL('/api/frp/enroll',publicUrl).href}),signal:AbortSignal.timeout(10000)});
     const result=await response.json();if(!response.ok)return res.status(400).json({error:result.error||'Не удалось подготовить FRPC'});input.enrollment=result;
    }
    body=JSON.stringify(input);headers['Content-Type']='application/json';headers['Content-Length']=String(Buffer.byteLength(body));
   }
   const response=await fetch(new URL(suffix,serviceUrl),{method:req.method,headers,...(body?{body,duplex:'half'}:{}),redirect:'error',signal:AbortSignal.timeout(120000)});
   if(response.status===401)return res.status(503).json({error:'Ключ сервиса подготовки прошивок не совпадает'});
   res.status(response.status);
   if(response.ok&&suffix.endsWith('/download')){res.set('Content-Type','application/octet-stream');res.set('Content-Disposition',response.headers.get('content-disposition')||'attachment; filename="firmware.bin"');await pipeline(Readable.fromWeb(response.body),res);}
   else res.json(await response.json());
  }catch{if(!res.headersSent)res.status(502).json({error:'Сервис прошивок недоступен или загрузка прервана'});else res.destroy();}
 };
};
