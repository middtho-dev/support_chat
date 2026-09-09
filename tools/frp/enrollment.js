'use strict';
const crypto = require('crypto');
const net = require('net');
const { availablePorts, suggestPort, routerScript, buildInstaller } = require('./installer');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function createEnrollment({ state, save, ranges, refresh, running, monitoringError, portFree = async port => {
  const server = net.createServer();
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: state.bindAddr, port, exclusive: true }, resolve); }); }
  catch { return false; }
  await new Promise(resolve => server.close(resolve)); return true;
} }) {
  state.enrollments ||= [];
  function find(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Недействительный файл установки');
    const record = state.enrollments.find(r => r.tokenHash === digest(token));
    if (!record || record.revoked || Date.parse(record.expiresAt) < Date.now()) throw new Error('Файл отозван или истёк срок действия. Создайте новый файл в панели.');
    return record;
  }
  return {
    list: () => state.enrollments.map(({ tokenHash, fingerprint, ...r }) => r),
    issue(input, firmware = false) {
      const name = String(input.name || '').trim();
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Имя устройства: 1–80 символов');
      if (!firmware && (typeof input.password !== 'string' || !input.password.length || input.password.length > 512 || /[\r\n\0]/.test(input.password))) throw new Error('SSH-пароль: 1–512 символов без переноса строки');
      const url = new URL(input.enrollmentUrl);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Для регистрации нужен HTTPS-адрес панели');
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/frp/enroll') throw new Error('Некорректный адрес регистрации');
      if (state.enrollments.filter(r => !r.revoked && Date.parse(r.expiresAt) > Date.now()).length >= 3001) throw new Error('Слишком много активных файлов. Отзовите неиспользуемые.');
      const localIP = String(input.localIP || '127.0.0.1').trim();
      const localPort = Number(input.localPort ?? 80);
      if (!net.isIP(localIP) || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('Укажите корректные IP и порт назначения (1–65535)');
      const token = crypto.randomBytes(32).toString('hex');
      const record = { localIP, localPort, id: crypto.randomBytes(12).toString('hex'), name, tokenHash: digest(token), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (firmware ? 30 : 7) * 86400000).toISOString(), port: null };
      if (firmware) { state.enrollments.push(record); save(); return { token, endpoint: url.href, expiresAt: record.expiresAt }; }
      const file = buildInstaller({ name, token, endpoint: url.href, password: input.password });
      state.enrollments.push(record); save();
      return { file, filename: `kv9ru-openwrt-${record.id.slice(0, 8)}.bat` };
    },
    revoke(id) {
      const record = state.enrollments.find(r => r.id === id);
      if (!record) throw new Error('Файл не найден');
      record.revoked = true; save();
    },
    async redeem(input) {
      const record = find(input.token);
      if (!/^[a-f0-9]{64}$/.test(input.fingerprint || '')) throw new Error('Не удалось определить идентификатор роутера');
      if (record.fingerprint && record.fingerprint !== input.fingerprint) throw new Error('Этот файл уже использован на другом роутере');
      if (!running()) throw new Error('FRP выключен. Включите сервер в панели и повторите запуск.');
      await refresh();
      if (monitoringError()) throw new Error('Не удалось проверить занятые порты FRP. Повторите позже.');
      if (input.operation === 'status') {
        const online = !!record.port && state.devices.some(d => d.name === `kv9_luci_${record.port}` && Number(d.port) === record.port && d.online);
        if (online && !record.completedAt) { record.completedAt = new Date().toISOString(); save(); }
        return { online, port: record.port, name: record.name };
      }
      if (input.operation !== 'claim') throw new Error('Неизвестная операция');
      if (!record.port) {
        const ports = availablePorts(state, ranges(), state.usedPorts);
        while (ports.length) {
          const port = suggestPort(ports); ports.splice(ports.indexOf(port), 1);
          if (!await portFree(port)) continue;
          record.port = port; record.fingerprint = input.fingerprint;
          state.installerReservations.push({ port, enrollmentId: record.id, createdAt: new Date().toISOString() });
          save(); break;
        }
        if (!record.port) throw new Error('Нет свободных разрешённых портов 20000–23000');
      }
      if (!ranges().some(r => record.port >= r.start && record.port <= r.end)) throw new Error('Выданный порт больше не разрешён настройками FRP');
      const conflict = state.devices.some(d => Number(d.port) === record.port && d.name !== `kv9_luci_${record.port}`);
      if (conflict) throw new Error('Выданный порт занят другим туннелем. Обратитесь к администратору.');
      return { port: record.port, name: record.name, host: state.host, script: Buffer.from(routerScript(state, record.port, record)).toString('base64') };
    }
  };
}
module.exports = { createEnrollment };
