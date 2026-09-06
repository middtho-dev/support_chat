'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFrp, validateConfig, allowedRanges } = require('../manager');
const { createServer } = require('../server');
const { DEFAULTS, initialConfig } = require('../config');

test('port ranges exclude service ports and retain both boundaries', () => {
  const ranges = allowedRanges([7000, 7400, 3001, 7400]);
  const includes = p => ranges.some(r => p >= r.start && p <= r.end);
  for (const p of [1000, 1999, 2000, 65535, 6999, 7001]) assert.ok(includes(p));
  for (const p of [999, 7000, 7400, 3001]) assert.ok(!includes(p));
  assert.deepEqual(allowedRanges([1000, 65535]), [{ start: 1001, end: 65534 }]);
});

test('configuration rejects invalid ports and TOML injection', () => {
  for (const port of [0, 999, 65536, 1000.5, 'abc']) assert.throws(() => validateConfig({ host: 'router.kv9.ru', port }));
  assert.throws(() => validateConfig({ host: 'evil"\nauth.token="x', port: 7000 }));
  assert.deepEqual(validateConfig({ host: 'router.kv9.ru', port: 7000 }), DEFAULTS);
});

test('range beginning at 1000 persists and service exclusions cannot be removed', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-range-'));
  let manager = createFrp({ directory });
  try {
    await manager.action('configure', { portStart: 1000, portEnd: 65535, reservedPorts: '1500' });
    await manager.shutdown(); manager = createFrp({ directory });
    const s = await manager.status();
    const includes = p => s.allowedRanges.some(r => p >= r.start && p <= r.end);
    assert.equal(s.portStart, 1000);
    for (const p of [1000, 1999, 65535]) assert.ok(includes(p));
    for (const p of [999, 1500, 2019, 3000, 3001, 7000, 7400]) assert.ok(!includes(p));
    await assert.rejects(manager.action('configure', { portStart: 999 }));
    await assert.rejects(manager.action('configure', { port: 2019 }), /зарезервирован/);
    await manager.action('configure', { portStart: 1100, portEnd: 1800 });
    assert.deepEqual((await manager.status()).allowedRanges, [{ start: 1100, end: 1499 }, { start: 1501, end: 1800 }]);
  } finally { await manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('custom ranges, addresses and initial environment settings are validated', () => {
  const config = initialConfig({ FRP_SERVER_HOST: 'custom.example.org', FRP_SERVER_PORT: '7100', FRP_PORT_START: '8000', FRP_PORT_END: '8100', FRP_RESERVED_PORTS: '8001,8001', FRP_REFRESH_SECONDS: '12' });
  assert.equal(config.host, 'custom.example.org'); assert.equal(config.port, 7100);
  assert.equal(config.refreshSeconds, 12);
  assert.deepEqual(allowedRanges(config.reservedPorts, config.portStart, config.portEnd), [{ start: 8000, end: 8000 }, { start: 8002, end: 8100 }]);
  assert.deepEqual(initialConfig({ FRP_RESERVED_PORTS: '' }).reservedPorts, []);
  assert.equal(validateConfig({ host: '::1', bindAddr: '::' }).host, '::1');
  assert.equal(validateConfig({ compatibilityMode: 'true' }).compatibilityMode, true);
  assert.equal(validateConfig({ compatibilityMode: 'false' }).compatibilityMode, false);
  assert.throws(() => validateConfig({ compatibilityMode: 'no' }));
  for (const input of [{ host: 'https://example.org' }, { host: '-invalid.org' }, { portStart: 9000, portEnd: 8000 }, { reservedPorts: 'oops' }, { refreshSeconds: 0 }, { historyLimit: -1 }, { bindAddr: 'x"\n' }]) assert.throws(() => validateConfig(input));
});

test('legacy typo migrates once, custom settings and token survive restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-migration-'));
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ host: 'routers.kv9.ru', port: 7000, enabled: false, token: 'original-device-token', dashboardPassword: 'private', devices: [], clients: [] }));
  let manager = createFrp({ directory });
  try {
    assert.equal((await manager.status()).host, 'router.kv9.ru');
    await manager.action('configure', { compatibilityMode: true });
    await manager.action('configure', { host: 'my-router.example.org', port: 7200, portStart: 8000, portEnd: 8100, reservedPorts: '8000,8002', refreshSeconds: 12, historyLimit: 200, newToken: 'replacement-device-token-12345' });
    const before = await manager.status();
    assert.equal(before.allowedRanges[0].start, 8001);
    await assert.rejects(manager.action('configure', { portStart: 7200, portEnd: 7200 }), /не осталось/);
    await assert.rejects(manager.action('configure', { newToken: 'short' }), /Токен/);
    assert.equal((await manager.status()).token, 'replacement-device-token-12345');
    await manager.shutdown(); manager = createFrp({ directory });
    const after = await manager.status();
    for (const key of ['compatibilityMode', 'host', 'port', 'portStart', 'portEnd', 'reservedPorts', 'refreshSeconds', 'historyLimit', 'token']) assert.deepEqual(after[key], before[key]);
    await manager.action('configure', { host: 'routers.kv9.ru' });
    await manager.shutdown(); manager = createFrp({ directory });
    assert.equal((await manager.status()).host, 'routers.kv9.ru');
  } finally { await manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('fresh install is stopped; settings and credentials persist independently', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-test-'));
  const first = createFrp({ directory });
  let second;
  try {
    const state = await first.status();
    assert.equal(state.host, 'router.kv9.ru'); assert.equal(state.port, 7000);
    assert.equal(state.running, false); assert.equal(state.installed, false);
    await assert.rejects(first.action('start'), /установите/);
    await assert.rejects(first.action('configure', { host: 'router.kv9.ru', port: 7400 }), /зарезервирован/);
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
