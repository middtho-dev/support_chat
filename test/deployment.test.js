'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createDeploymentInfo } = require('../src/deployment');
function response() { return { code: 200, set() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } }; }
test('deployment inventory requires manager access before reading service or DNS', async () => {
  for (const access of [{authenticated:false}, {authenticated:true,canManageSettings:false}]) {
    const handler = createDeploymentInfo({authorize:()=>access, fetcher:()=>{throw Error('Must not fetch');}}), res=response();
    await handler({get:()=>''},res); assert.equal(res.code,access.authenticated?403:401);
  }
});
test('deployment inventory reads current FRP config and exposes only public addresses', async () => {
  const env={PUBLIC_URL:'https://user:secret@panel.example/path?token=hidden',PUBLIC_SERVER_IPV4:'203.0.113.8',PUBLIC_SERVER_IPV6:'invalid',FRP_SERVICE_TOKEN:'private-service-key',FRP_SERVICE_URL:'http://127.0.0.1:7400'};
  const handler=createDeploymentInfo({authorize:()=>({authenticated:true,canManageSettings:true}),env,
    fetcher:async(url,options)=>{assert.equal(options.headers['x-admin-token'],env.FRP_SERVICE_TOKEN);return Response.json({host:'routers.example',port:7001,portStart:1000,portEnd:65000,reservedPorts:[3001],token:'hidden-frp-token',clients:[{secret:'private'}]});},
    resolver:{resolve4:async()=>['198.51.100.2'],resolve6:async()=>{throw Object.assign(Error(),{code:'ENODATA'});}}});
  const res=response();await handler({get:()=>''},res);
  assert.equal(res.data.ipv4,env.PUBLIC_SERVER_IPV4);assert.equal(res.data.ipv6,'');assert.equal(res.data.frp.port,7001);
  assert.equal(res.data.publicUrl,'https://panel.example/path');assert.equal(res.data.records.length,2);assert.deepEqual(res.data.records[0].aaaa,[]);
  assert.ok(!/secret|hidden|private/.test(JSON.stringify(res.data)));
});
test('unavailable FRP and DNS do not hide the configured migration target', async () => {
  const res=response();await createDeploymentInfo({authorize:()=>({authenticated:true,canManageSettings:true}),env:{PUBLIC_URL:'https://panel.example',PUBLIC_SERVER_IPV4:'203.0.113.9',FRP_SERVICE_TOKEN:'test'},fetcher:async()=>{throw Error('offline');},resolver:{resolve4:async()=>{throw Error('offline');},resolve6:async()=>{throw Error('offline');}}})({get:()=>''},res);
  assert.equal(res.data.frp,null);assert.equal(res.data.records[0].a,null);assert.equal(res.data.ipv4,'203.0.113.9');
});
