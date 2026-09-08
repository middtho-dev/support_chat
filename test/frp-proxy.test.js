const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { createFrpProxy } = require('../src/frp-proxy');
const { deviceUrl, primaryProxy, groupDevices } = require('../tools/frp/public/device-links');

test('unified FRP API checks admin/Mini App permissions and hides service credentials', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ token: req.headers['x-admin-token'], url: req.url, method: req.method });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ running: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  let revoked = false;
  const app = express(); app.use(express.json());
  app.use('/api/admin/frp', createFrpProxy({ serviceToken: 'internal-service-secret', serviceUrl: `http://127.0.0.1:${upstream.address().port}`,
    authorize: token => ({ authenticated: ['admin', 'mini-manager', 'mini-operator'].includes(token), canManageSettings: token === 'admin' || (token === 'mini-manager' && !revoked) }) }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/admin/frp`;
  try {
    for (const token of [undefined, 'expired']) assert.equal((await fetch(url, { headers: token ? { 'x-admin-token': token } : {} })).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-admin-token': 'mini-operator' } })).status, 403);
    for (const token of ['admin', 'mini-manager']) {
      const response = await fetch(url, { headers: { 'x-admin-token': token } });
      assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(await response.json(), { running: true });
    }
    assert.equal((await fetch(url + '/start', { method: 'POST', headers: { 'x-admin-token': 'mini-manager', 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
    for (const action of ['generate-installer', 'release-installer']) {
      for (const token of ['admin', 'mini-manager', 'mini-operator', 'expired']) {
        const response = await fetch(url + '/' + action, { method: 'POST', headers: { 'x-admin-token': token, 'Content-Type': 'application/json' }, body: '{}' });
        assert.equal(response.status, token === 'expired' ? 401 : token === 'mini-operator' ? 403 : 200);
      }
    }
    revoked = true;
    assert.equal((await fetch(url, { headers: { 'x-admin-token': 'mini-manager' } })).status, 403);
    assert.equal((await fetch(url + '/shell', { method: 'POST', headers: { 'x-admin-token': 'admin' } })).status, 404);
    assert.equal(seen.length, 7); assert.ok(seen.every(r => r.token === 'internal-service-secret'));
    await new Promise(resolve => upstream.close(resolve));
    assert.equal((await fetch(url, { headers: { 'x-admin-token': 'admin' } })).status, 502);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); upstream.closeAllConnections(); upstream.close(); }
});

test('device names use the device HTTP port, SSH uses SSH and unsafe URLs are rejected', () => {
  const web = { name: 'Home_Luci', port: 8017, type: 'tcp', online: true };
  const ssh = { name: 'Home_SSH', port: 2221, type: 'tcp', online: true };
  assert.equal(groupDevices([{...web,displayName:'Дом · роутер'}])[0].name, 'Дом · роутер');
  assert.equal(deviceUrl('router.kv9.ru', web), 'http://router.kv9.ru:8017/');
  assert.equal(deviceUrl('router.kv9.ru', ssh), 'ssh://router.kv9.ru:2221/');
  assert.equal(primaryProxy([ssh, web]), web);
  assert.equal(primaryProxy([ssh]), undefined);
  assert.equal(deviceUrl('javascript:alert(1)', web), null);
  assert.equal(deviceUrl('router.kv9.ru', { ...web, type: 'udp' }), null);
  assert.equal(deviceUrl('router.kv9.ru', { ...web, port: 99999 }), null);
});

test('one device contains all its ports; empty stale sessions do not inflate totals', () => {
  const ports = [
    { name: 'Home_SSH', clientID: 'new', type: 'tcp', port: 2221, online: true },
    { name: 'Home_Luci', clientID: 'new', type: 'tcp', port: 8021, online: true },
    { name: 'Home_extra', clientID: 'new', type: 'udp', port: 9000, online: true },
    { name: 'Other_Luci', clientID: 'other', type: 'tcp', port: 8040, online: false }
  ];
  const rows = groupDevices(ports, [
    { clientID: 'old', ip: 'same-nat', online: false },
    { clientID: 'new', ip: 'same-nat', online: true },
    { clientID: 'other', ip: 'same-nat', online: false },
    { clientID: 'no-tunnels', online: true }
  ]);
  assert.equal(rows.length, 3);
  const home = rows.find(r => r.name === 'Home');
  assert.equal(home.ports.length, 3);
  assert.equal(home.primary.port, 8021);
  assert.equal(rows.find(r => r.name === 'Other').online, false);
  assert.equal(rows.find(r => r.name === 'no-tunnels').ports.length, 0);
  assert.equal(groupDevices([{ name: 'Legacy_Luci', online: true }, { name: 'Legacy_SSH', online: true }]).length, 1);
});

test('public installer proxy uses only the scoped capability and cannot forward admin actions', async () => {
  const seen=[];
  const upstream=http.createServer((req,res)=>{seen.push({url:req.url,auth:req.headers.authorization,admin:req.headers['x-admin-token']});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({port:21065}));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const app=express();app.use(express.json());app.use('/api/frp/enroll',require('../src/frp-proxy').createFrpEnrollmentProxy({serviceUrl:`http://127.0.0.1:${upstream.address().port}`}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/api/frp/enroll`;
  try{assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal((await fetch(url)).status,405);
    const token='a'.repeat(64);const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({operation:'claim',fingerprint:'b'.repeat(64),action:'stop'})});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(seen,[{url:'/api/frp/enroll',auth:'Bearer '+token,admin:undefined}]);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}
});
