'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const exec = promisify(execFile);
const { createEnrollment } = require('./enrollment');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { DEFAULTS, validateConfig, initialConfig } = require('./config');

function allowedRanges(excluded, first = DEFAULTS.portStart, last = DEFAULTS.portEnd) {
  const ports = [...new Set(excluded.filter(p => p >= first && p <= last))].sort((a, b) => a - b);
  const ranges = [];
  let start = first;
  for (const port of ports) { if (start < port) ranges.push({ start, end: port - 1 }); start = port + 1; }
  if (start <= last) ranges.push({ start, end: last });
  return ranges;
}

function createFrp({ directory = process.env.FRP_DIR || path.join(__dirname, 'data') } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const statePath = path.join(directory, 'state.json');
  const binary = path.join(directory, process.platform === 'win32' ? 'frps.exe' : 'frps');
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
    ...initialConfig(), schemaVersion: 1, enabled: false, token: crypto.randomBytes(32).toString('hex'),
    dashboardPassword: crypto.randomBytes(32).toString('hex'), devices: []
  };
  // Correct the original shipped typo once; never overwrite a custom hostname.
  if (!state.schemaVersion && state.host === 'routers.kv9.ru') state.host = DEFAULTS.host;
  Object.assign(state, validateConfig({ ...initialConfig(), ...state }), { schemaVersion: 1 });
  let child = null, busy = false, error = null, monitoringError = null, closing = false;
  let dashboardPort = 0;
  let refreshing = null;
  state.clients ||= [];
  state.installerReservations ||= [];
  state.usedPorts = [...new Set([...(state.usedPorts || []), ...state.devices.map(d => Number(d.port)).filter(p => p > 0)])];
  const panelPort = Number(process.env.FRP_PANEL_PORT || 7400);
  const servicePorts = [...new Set([2019, 3000, 3001, Number(process.env.FRP_CHAT_PORT || 3001), panelPort])];
  const exclusionsFor = (config = state) => [...new Set([config.port, dashboardPort, ...servicePorts, ...config.reservedPorts])].filter(p => p > 0).sort((a, b) => a - b);
  const rangesFor = (config = state) => allowedRanges(exclusionsFor(config), config.portStart, config.portEnd);
  const save = () => {
    fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(statePath + '.tmp', statePath);
  };
  save();
  async function dashboard(route) {
    const res = await fetch(`http://127.0.0.1:${dashboardPort}/api/${route}`, {
      headers: { Authorization: `Basic ${Buffer.from(`admin:${state.dashboardPassword}`).toString('base64')}` },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) throw new Error(`FRP API: HTTP ${res.status}`);
    return res.json();
  }
  async function refresh() {
    if (!child) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const [clients, ...lists] = await Promise.all([dashboard('clients'), ...['tcp', 'udp'].map(async type => {
          const data = await dashboard(`proxy/${type}`);
          if (!Array.isArray(data.proxies)) throw new Error('Неизвестный формат FRP API');
          return data.proxies.map(p => ({ name: String(p.name), type, port: p.conf?.remotePort ?? null,
            user: p.user || '', clientID: p.clientID || '', online: p.status === 'online', connections: p.curConns || 0 }));
        })]);
        if (!Array.isArray(clients)) throw new Error('Неизвестный формат списка клиентов FRP');
        if (!child) return;
        const known = new Map(state.devices.map(d => [`${d.type}:${d.name}`, { ...d, online: false }]));
        for (const d of lists.flat()) {
          const key = `${d.type}:${d.name}`;
          known.set(key, { ...known.get(key), ...d, port: d.port ?? known.get(key)?.port ?? null, lastSeen: d.online ? new Date().toISOString() : known.get(key)?.lastSeen || null });
        }
        state.devices = [...known.values()].slice(-state.historyLimit);
        state.usedPorts = [...new Set([...state.usedPorts, ...lists.flat().map(d => Number(d.port)).filter(p => p > 0)])];
        const knownClients = new Map(state.clients.map(c => [c.key, { ...c, online: false }]));
        for (const c of clients) knownClients.set(c.key, {
          key: c.key, clientID: c.clientID, user: c.user, hostname: c.hostname, ip: c.clientIP,
          online: c.online, lastSeen: c.online ? new Date().toISOString() : knownClients.get(c.key)?.lastSeen || null
        });
        state.clients = [...knownClients.values()].slice(-state.historyLimit);
        monitoringError = null;
        save();
      } catch (e) { monitoringError = e.message; }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function stop() {
    const proc = child;
    if (!proc) return;
    proc.kill('SIGTERM');
    for (let i = 0; i < 40 && child === proc; i++) await delay(100);
    if (child === proc) {
      proc.kill('SIGKILL');
      for (let i = 0; i < 20 && child === proc; i++) await delay(100);
    }
    if (child === proc) throw new Error('Не удалось остановить FRP');
  }
  async function start() {
    if (closing) throw new Error('Панель завершает работу');
    if (child) return;
    if (!fs.existsSync(binary)) throw new Error('Сначала установите FRP');
    // The dashboard uses a free loopback port and is never exposed publicly.
    const net = require('net');
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    dashboardPort = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const ranges = rangesFor();
    if (!ranges.length) throw new Error('В диапазоне не осталось разрешённых портов');
    const config = `bindAddr = ${JSON.stringify(state.bindAddr)}\nbindPort = ${state.port}\nauth.method = "token"\nauth.token = ${JSON.stringify(state.compatibilityMode ? "" : state.token)}\ntransport.tls.force = ${!state.compatibilityMode}\nwebServer.addr = "127.0.0.1"\nwebServer.port = ${dashboardPort}\nwebServer.user = "admin"\nwebServer.password = ${JSON.stringify(state.dashboardPassword)}\nallowPorts = [${ranges.map(r => `{ start = ${r.start}, end = ${r.end} }`).join(', ')}]\n`;
    const configPath = path.join(directory, 'frps.toml');
    fs.writeFileSync(configPath, config, { mode: 0o600 });
    if (closing) throw new Error('Панель завершает работу');
    const proc = spawn(binary, ['-c', configPath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child = proc;
    let output = '';
    const capture = chunk => { output = (output + chunk.toString()).slice(-2000); };
    proc.stdout.on('data', capture); proc.stderr.on('data', capture);
    proc.once('error', e => { error = e.message; if (child === proc) child = null; });
    proc.once('exit', code => {
      if (child === proc) child = null;
      if (code && !closing) error = `FRP завершился (${code}): ${output.replaceAll(state.token, '[secret]').replaceAll(state.dashboardPassword, '[secret]')}`;
    });
    for (let i = 0; i < 30; i++) {
      if (!child) throw new Error(error || 'FRP не запустился');
      try { await dashboard('serverinfo'); error = null; await refresh(); return; } catch { await delay(200); }
    }
    await stop();
    throw new Error('FRP не ответил после запуска. Проверьте доступность порта.');
  }
  async function install() {
    if (child) throw new Error('Остановите FRP перед установкой');
    const platform = { linux: 'linux', win32: 'windows', darwin: 'darwin' }[process.platform];
    const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    if (!platform || !arch) throw new Error('Поддерживаются Linux, Windows и macOS: x64/arm64');
    const response = await fetch('https://api.github.com/repos/fatedier/frp/releases/latest', { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`GitHub: HTTP ${response.status}`);
    const release = await response.json();
    const version = String(release.tag_name).replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Некорректная версия FRP');
    const stem = `frp_${version}_${platform}_${arch}`;
    const asset = release.assets.find(a => a.name === `${stem}.${platform === 'windows' ? 'zip' : 'tar.gz'}`);
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('Для архива FRP отсутствует SHA-256');
    const url = new URL(asset.browser_download_url);
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/fatedier/frp/releases/download/')) throw new Error('Некорректный адрес загрузки FRP');
    const download = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!download.ok) throw new Error(`Загрузка FRP: HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== asset.digest) throw new Error('Контрольная сумма FRP не совпала');
    const temporary = fs.mkdtempSync(path.join(directory, 'install-'));
    try {
      const archive = path.join(temporary, asset.name);
      fs.writeFileSync(archive, bytes);
      const member = `${stem}/${path.basename(binary)}`;
      await exec('tar', ['-xf', archive, '-C', temporary, member], { timeout: 30000, windowsHide: true });
      const extracted = path.join(temporary, path.basename(binary));
      fs.renameSync(path.join(temporary, member), extracted);
      fs.chmodSync(extracted, 0o700);
      await exec(extracted, ['--version'], { timeout: 10000, windowsHide: true });
      fs.copyFileSync(extracted, binary + '.new');
      fs.chmodSync(binary + '.new', 0o700);
      fs.renameSync(binary + '.new', binary);
      state.version = version; save();
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const enrollment = createEnrollment({ state, save, ranges: rangesFor, refresh, running: () => !!child, monitoringError: () => monitoringError });
  let timer;
  function scheduleRefresh() {
    clearInterval(timer);
    timer = setInterval(() => { if (!busy && !closing) refresh(); }, state.refreshSeconds * 1000);
    timer.unref();
  }
  scheduleRefresh();
  return {
    async init() { if (state.enabled) { busy = true; try { await start(); } catch (e) { error = e.message; } finally { busy = false; } } },
    async status() {
      return { installed: fs.existsSync(binary), version: state.version || null, running: !!child, busy,
        enabled: state.enabled, ...validateConfig(state), error, monitoringError,
        allowedRanges: rangesFor(), excludedPorts: exclusionsFor(),
        enrollments: enrollment.list(),
        installerReservations: state.installerReservations,
        devices: state.devices.map(d => ({ ...d, displayName: state.enrollments.find(r => r.port === Number(d.port) && d.name === `kv9_luci_${r.port}`)?.name || '', online: child && !monitoringError ? d.online : false, stale: !!monitoringError })),
        clients: state.clients.map(c => ({ ...c, online: child && !monitoringError ? c.online : false, stale: !!monitoringError })),
        token: state.token };
    },
    async action(action, config = {}) {
      if (busy || closing) throw new Error('Дождитесь завершения текущей операции');
      busy = true; error = null;
      try {
        if (action === 'generate-installer') {
          const result = enrollment.issue(config);
          return { ...result, status: { ...await this.status(), busy: false } };
        }
        else if (action === 'enroll') return await enrollment.redeem(config);
        else if (action === 'revoke-installer') enrollment.revoke(config.id);
        else if (action === 'release-installer') {
          const port = Number(config.port);
          state.installerReservations = state.installerReservations.filter(r => r.port !== port || r.enrollmentId); save();
        }
        else if (action === 'install') await install();
        else if (action === 'start') { await start(); state.enabled = true; save(); }
        else if (action === 'stop') { state.enabled = false; save(); await stop(); }
        else if (action === 'configure') {
          const validated = validateConfig({ ...state, ...config });
          if ([...servicePorts, ...validated.reservedPorts].includes(validated.port)) throw new Error('Этот порт зарезервирован другим приложением');
          if (!rangesFor(validated).length) throw new Error('В диапазоне не осталось разрешённых портов');
          if (config.newToken && (typeof config.newToken !== 'string' || !/^[\x21-\x7e]{24,256}$/.test(config.newToken))) throw new Error('Токен: 24–256 печатных ASCII-символов без пробелов');
          const previous = { ...validateConfig(state), token: state.token };
          const restart = !!child;
          if (restart) { await stop(); if (refreshing) await refreshing; }
          Object.assign(state, validated, config.newToken ? { token: config.newToken } : {}); save(); scheduleRefresh();
          if (restart) {
            try { await start(); }
            catch (e) {
              await stop(); Object.assign(state, previous); save(); scheduleRefresh();
              try { await start(); } catch (rollbackError) { throw new Error(`Новые настройки не применены: ${e.message}. Не удалось восстановить запуск: ${rollbackError.message}`); }
              throw new Error(`Новые настройки не применены, восстановлены предыдущие: ${e.message}`);
            }
          }
        } else throw new Error('Неизвестная операция');
      } catch (e) { if (action !== 'enroll') error = e.message; throw e; } finally { busy = false; }
      return this.status();
    },
    async shutdown() { closing = true; clearInterval(timer); await stop(); if (refreshing) await refreshing; }
  };
}

module.exports = { createFrp, validateConfig, allowedRanges };
