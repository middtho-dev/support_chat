'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { availablePorts, validateRouter, routerScript, buildInstaller } = require('../installer');
const { createFrp } = require('../manager');
const state = { host: 'router.example.org', port: 7100, token: 'token-with-quote\'and-$shell', compatibilityMode: false };

test('installer allocation excludes offline devices, reservations, service ports and both boundaries', () => {
  const ports = availablePorts({ devices: [{ port: 20000, online: false }], installerReservations: [{ port: 23000 }] }, [{ start: 20000, end: 23000 }], [21000]);
  assert.equal(ports.length, 2998);
  for (const port of [19999, 20000, 21000, 23000, 23001]) assert.ok(!ports.includes(port));
  assert.deepEqual(availablePorts({}, [{ start: 1000, end: 19999 }]), []);
});

test('router input is validated and secrets are data, never Windows shell commands', () => {
  for (const ip of ['-proxycmd evil', '192.168.1.1 & calc', 'http://192.168.1.1', 'router']) assert.throws(() => validateRouter({ ip, password: 'valid' }));
  for (const password of ['', 'x\ny', 'x\0y']) assert.throws(() => validateRouter({ ip: '::1', password }));
  assert.throws(() => validateRouter({ ip: '::1', password: 'x', sshPort: 65536 }));
  const password = 'Пароль & %PATH% " $(bad) ` !';
  const file = buildInstaller(state, 21065, { ip: '192.168.1.1', password });
  assert.ok(!file.includes(password)); assert.ok(!file.includes(state.token));
  const payload = JSON.parse(Buffer.from(file.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString());
  assert.equal(payload.password, password); assert.equal(payload.sshPort, 22);
  const script = Buffer.from(payload.script, 'base64').toString();
  assert.match(script, /server='router.example.org'/); assert.match(script, /port='21065'/);
  assert.match(script, /local_port=80/); assert.match(script, /apk add frpc luci-app-frpc/); assert.match(script, /opkg install frpc luci-app-frpc/);
  assert.ok(!routerScript({ ...state, compatibilityMode: true }, 21065).includes(state.token));
});

test('port reservation is atomic, persistent and contains no SSH credentials', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-installer-'));
  let manager = createFrp({ directory });
  try {
    const port = (await manager.status()).installerPort;
    const results = await Promise.allSettled([1, 2].map(() => manager.action('generate-installer', { port, ip: '192.168.1.1', password: 'private-router-password' })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(!fs.readFileSync(path.join(directory, 'state.json'), 'utf8').includes('private-router-password'));
    await manager.shutdown(); manager = createFrp({ directory });
    await assert.rejects(manager.action('generate-installer', { port, ip: '192.168.1.1', password: 'x' }), /занят/);
    await manager.action('release-installer', { port });
    assert.equal((await manager.status()).installerReservations.length, 0);
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(port, '0.0.0.0', resolve));
    try { await assert.rejects(manager.action('generate-installer', { port, ip: '192.168.1.1', password: 'x' }), /сервисом/); }
    finally { await new Promise(resolve => listener.close(resolve)); }
  } finally { await manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const pm of ['opkg', 'apk']) for (const failure of [false, true]) test(`OpenWrt script ${pm}: ${failure ? 'rollback on restart failure' : 'package install and LuCI configuration'}`, { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frp-router-'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'etc/config'), { recursive: true }); fs.mkdirSync(path.join(dir, 'etc/init.d'));
  fs.writeFileSync(path.join(dir, 'etc/openwrt_release'), 'OpenWrt');
  const put = (name, content) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n' + content, { mode: 0o755 });
  put('id', 'echo 0\n'); put('sleep', 'exit 0\n');
  put(pm, `echo "$*" >> '${dir}/packages'\nprintf 'original-config\\n' > '${dir}/etc/config/frpc'\n`);
  put('uci', `printf '%s\\n' "$*" >> '${dir}/uci-log'\ncase "$*" in *' get '*) exit 1;; esac\n`);
  fs.writeFileSync(path.join(dir, 'etc/init.d/frpc'), '#!/bin/sh\n' + (failure ? '[ "$1" != restart ]\n' : 'exit 0\n'), { mode: 0o755 });
  const script = routerScript(state, 21065).replaceAll('/etc/', dir + '/etc/').replaceAll('/tmp/kv9-frpc-install.lock', dir + '/lock');
  const scriptPath = path.join(dir, 'router.sh'); fs.writeFileSync(scriptPath, script);
  try {
    execFileSync('sh', ['-n', scriptPath]);
    const remoteCommand = fs.readFileSync(path.join(__dirname, '../installer/windows.ps1'), 'utf8').replace(/\r\n/g, '\n').match(/\$remoteCommand = @'\n([\s\S]*?)\n'@/)[1];
    const run = () => execFileSync('sh', ['-c', remoteCommand], { input: script.replace(/\n/g, '\r\n'), env: { ...process.env, PATH: bin + ':/usr/bin:/bin' }, encoding: 'utf8', stdio: 'pipe' });
    if (failure) assert.throws(run); else assert.match(run(), /FRPC is running/);
    const log = fs.readFileSync(path.join(dir, 'uci-log'), 'utf8');
    assert.match(log, /set frpc.kv9_luci_21065.local_port=80/);
    assert.match(log, /set frpc.kv9_luci_21065.remote_port=21065/);
    assert.match(log, /set frpc.common.server_addr=router.example.org/);
    assert.match(fs.readFileSync(path.join(dir, 'packages'), 'utf8'), /frpc luci-app-frpc/);
    if (failure) assert.equal(fs.readFileSync(path.join(dir, 'etc/config/frpc'), 'utf8'), 'original-config\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
