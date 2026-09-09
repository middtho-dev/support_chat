const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),express=require('express');
const {createFirmwareProxy}=require('../src/firmware-proxy');
test('firmware proxy protects binary uploads/downloads and injects only a server-issued FRPC capability',async()=>{
 const seen=[];const upstream=http.createServer(async(req,res)=>{let body=Buffer.alloc(0);for await(const c of req)body=Buffer.concat([body,c]);seen.push({path:req.url,token:req.headers['x-admin-token'],body});if(req.url.endsWith('/download')){res.setHeader('Content-Disposition','attachment; filename="firmware.bin"');return res.end(Buffer.from([0,1,2,255]));}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url.endsWith('issue-firmware')?{token:'server-issued-secret',endpoint:'https://panel.example.org/api/frp/enroll'}:{id:'job'}));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const upstreamUrl='http://127.0.0.1:'+upstream.address().port;
 const app=express();app.use(express.json());app.use('/firmware',createFirmwareProxy({authorize:t=>({authenticated:['admin','operator'].includes(t),canManageSettings:t==='admin'}),serviceUrl:upstreamUrl,serviceToken:'worker-secret',frpUrl:upstreamUrl,frpToken:'frp-secret',publicUrl:'https://panel.example.org'}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port+'/firmware';const auth={'x-admin-token':'admin'};
 try{
  for(const path of ['', '/jobs/'+'a'.repeat(32)+'/download']){assert.equal((await fetch(url+path)).status,401);assert.equal((await fetch(url+path,{headers:{'x-admin-token':'operator'}})).status,403);}
  assert.equal(seen.length,0);
  const upload=Buffer.from([0,255,128,33]);assert.equal((await fetch(url+'/images',{method:'POST',headers:{...auth,'Content-Type':'application/octet-stream'},body:upload})).status,200);assert.deepEqual(seen[0].body,upload);assert.equal(seen[0].token,'worker-secret');
  const response=await fetch(url+'/jobs',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({frpc:true,name:'Router',enrollment:{token:'attacker'},localIP:'127.0.0.1',localPort:80})});assert.equal(response.status,200);assert.equal(JSON.stringify(await response.json()).includes('secret'),false);assert.equal(seen[1].token,'frp-secret');assert.equal(JSON.parse(seen[2].body).enrollment.token,'server-issued-secret');
  const binary=await fetch(url+'/jobs/'+'a'.repeat(32)+'/download',{headers:auth});assert.deepEqual(Buffer.from(await binary.arrayBuffer()),Buffer.from([0,1,2,255]));assert.equal(binary.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(url+'/shell',{method:'POST',headers:auth})).status,404);
 }finally{server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>upstream.close(r))]);}
});
