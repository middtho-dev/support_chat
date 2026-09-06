'use strict';
const net = require('net');

const DEFAULTS = Object.freeze({ host: 'router.kv9.ru', port: 7000, bindAddr: '0.0.0.0',
  portStart: 2000, portEnd: 65535, reservedPorts: [3000, 3001], refreshSeconds: 5, historyLimit: 10000 });

function integer(value, min, max, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label}: допустимо ${min}–${max}`);
  return number;
}
function validateConfig(input) {
  const value = { ...DEFAULTS, ...input };
  value.host = String(value.host || '').trim();
  if (!net.isIP(value.host) && !(value.host.length <= 253 && value.host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)))) {
    throw new Error('Укажите домен или IP сервера без протокола и порта');
  }
  value.bindAddr = String(value.bindAddr || '').trim();
  if (!net.isIP(value.bindAddr)) throw new Error('Адрес прослушивания должен быть IPv4 или IPv6');
  value.port = integer(value.port, 2000, 65535, 'Порт подключения');
  value.portStart = integer(value.portStart, 2000, 65535, 'Начало диапазона');
  value.portEnd = integer(value.portEnd, value.portStart, 65535, 'Конец диапазона');
  const reserved = Array.isArray(value.reservedPorts) ? value.reservedPorts : String(value.reservedPorts).split(',').map(p => p.trim()).filter(Boolean);
  value.reservedPorts = [...new Set(reserved.map(p => integer(p, 1, 65535, 'Зарезервированный порт')))].sort((a, b) => a - b);
  value.refreshSeconds = integer(value.refreshSeconds, 2, 300, 'Интервал обновления');
  value.historyLimit = integer(value.historyLimit, 100, 100000, 'Лимит истории');
  return Object.fromEntries(Object.keys(DEFAULTS).map(key => [key, value[key]]));
}
function initialConfig(env = process.env) {
  const names = { host: 'FRP_SERVER_HOST', port: 'FRP_SERVER_PORT', bindAddr: 'FRP_BIND_ADDR', portStart: 'FRP_PORT_START', portEnd: 'FRP_PORT_END', reservedPorts: 'FRP_RESERVED_PORTS', refreshSeconds: 'FRP_REFRESH_SECONDS', historyLimit: 'FRP_HISTORY_LIMIT' };
  return validateConfig(Object.fromEntries(Object.entries(names).filter(([, name]) => env[name] !== undefined).map(([key, name]) => [key, env[name]])));
}
module.exports = { DEFAULTS, validateConfig, initialConfig };
