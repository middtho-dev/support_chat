'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFrp, validateConfig, allowedRanges } = require('../manager');
const { createServer } = require('../server');

test('port ranges exclude service ports and retain both boundaries', () => {
  const ranges = allowedRanges([7000, 7400, 3001, 7400]);
  const includes = p => ranges.some(r => p >= r.start && p <= r.end);
  for (const p of [2000, 65535, 6999, 7001]) assert.ok(includes(p));
  for (const p of [1999, 7000, 7400, 3001]) assert.ok(!includes(p));
  assert.deepEqual(allowedRanges([2000, 65535]), [{ start: 2001, end: 65534 }]);
});

test('configuration rejects invalid ports and TOML injection', () => {
  for (const port of [0, 1999, 65536, 2000.5, 'abc']) assert.throws(() => validateConfig({ host: 'routers.kv9.ru', port }));
  assert.throws(() => validateConfig({ host: 'evil"\nauth.token="x', port: 7000 }));
  assert.deepEqual(validateConfig({ host: 'routers.kv9.ru', port: 7000 }), { host: 'routers.kv9.ru', port: 7000 });
});

test('fresh install is stopped; settings and credentials persist independently', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-test-'));
  const first = createFrp({ directory });
  let second;
  try {
    const state = await first.status();
    assert.equal(state.host, 'routers.kv9.ru'); assert.equal(state.port, 7000);
    assert.equal(state.running, false); assert.equal(state.installed, false);
    await assert.rejects(first.action('start'), /установите/);
    await assert.rejects(first.action('configure', { host: 'routers.kv9.ru', port: 7400 }), /зарезервирован/);
    await first.action('configure', { host: 'example.org', port: 7001 });
    await first.shutdown();
    second = createFrp({ directory });
    assert.equal((await second.status()).host, 'example.org');
    assert.equal((await second.status()).token, state.token);
  } finally { await first.shutdown(); await second?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('standalone HTTP API requires its own token and validates requests', async () => {
  const calls = [];
  const token = 'separate-frp-administrator-token';
  const server = createServer({ status: async () => ({ running: false }), action: async (...args) => { calls.push(args); return { ok: true }; } }, token);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const headers of [{}, { 'x-admin-token': 'chat-admin-token' }]) {
      assert.equal((await fetch(base + '/api/admin/frp', { headers })).status, 401);
      assert.equal((await fetch(base + '/api/admin/frp/start', { method: 'POST', headers })).status, 401);
    }
    const headers = { 'x-admin-token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/admin/frp', { headers })).status, 200);
    assert.equal((await fetch(base + '/api/admin/frp/configure', { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(base + '/api/admin/frp/start', { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(base + '/api/admin/frp/shell', { method: 'POST', headers })).status, 404);
    assert.equal((await fetch(base + '/api/admin/frp/configure', { method: 'POST', headers, body: 'x'.repeat(5000) })).status, 413);
    assert.equal((await fetch(base + '/data/state.json')).status, 404);
    assert.equal((await fetch(base + '/')).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
