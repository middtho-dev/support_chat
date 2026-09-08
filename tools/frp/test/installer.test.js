'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');
const { availablePorts, routerScript, buildInstaller } = require('../installer');
const { createFrp } = require('../manager');
const state = { host: 'router.example.org', port: 7100, token: 'token-with-quote\'and-$shell', compatibilityMode: false };

test('installer allocation excludes offline devices, reservations, service ports and both boundaries', () => {
  const ports = availablePorts({ devices: [{ port: 20000, online: false }], installerReservations: [{ port: 23000 }] }, [{ start: 20000, end: 23000 }], [21000]);
  assert.equal(ports.length, 2998);
  for (const port of [19999, 20000, 21000, 23000, 23001]) assert.ok(!ports.includes(port));
  assert.deepEqual(availablePorts({}, [{ start: 1000, end: 19999 }]), []);
});

test('installer contains only a scoped capability, name and URL, encoded password but no assigned port', () => {
  const config = { name: 'Кухня & %PATH% " $(bad)', token: 'a'.repeat(64), password: 'secret & %PATH%', endpoint: 'https://example.org/api/frp/enroll' };
  const file = buildInstaller(config);
  assert.ok(!file.includes(config.name));
  const payload = JSON.parse(Buffer.from(file.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString());
  assert.deepEqual(payload, config);
  assert.ok(!file.includes(config.password)); assert.ok(!('port' in payload));
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
    const remoteCommand = fs.readFileSync(path.join(__dirname, '../installer/windows.ps1'), 'utf8').replace(/\r\n/g, '\n').match(/\$remoteCommand = @"\n([\s\S]*?)\n"@/)[1].replaceAll('`$', '$');
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
