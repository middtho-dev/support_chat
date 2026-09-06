const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { createFrpProxy } = require('../src/frp-proxy');
const { deviceUrl, primaryProxy } = require('../tools/frp/public/device-links');

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
    revoked = true;
    assert.equal((await fetch(url, { headers: { 'x-admin-token': 'mini-manager' } })).status, 403);
    assert.equal((await fetch(url + '/shell', { method: 'POST', headers: { 'x-admin-token': 'admin' } })).status, 404);
    assert.equal(seen.length, 3); assert.ok(seen.every(r => r.token === 'internal-service-secret'));
    await new Promise(resolve => upstream.close(resolve));
    assert.equal((await fetch(url, { headers: { 'x-admin-token': 'admin' } })).status, 502);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); upstream.closeAllConnections(); upstream.close(); }
});

test('device names use the device HTTP port, SSH uses SSH and unsafe URLs are rejected', () => {
  const web = { name: 'Home_Luci', port: 8017, type: 'tcp', online: true };
  const ssh = { name: 'Home_SSH', port: 2221, type: 'tcp', online: true };
  assert.equal(deviceUrl('router.kv9.ru', web), 'http://router.kv9.ru:8017/');
  assert.equal(deviceUrl('router.kv9.ru', ssh), 'ssh://router.kv9.ru:2221/');
  assert.equal(primaryProxy([ssh, web]), web);
  assert.equal(deviceUrl('javascript:alert(1)', web), null);
  assert.equal(deviceUrl('router.kv9.ru', { ...web, type: 'udp' }), null);
  assert.equal(deviceUrl('router.kv9.ru', { ...web, port: 99999 }), null);
});
