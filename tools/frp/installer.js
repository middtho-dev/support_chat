'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

function availablePorts(state, ranges, exclusions = []) {
  const occupied = new Set([...exclusions, ...(state.devices || []).map(d => Number(d.port)), ...(state.installerReservations || []).map(r => r.port)]);
  return Array.from({ length: 3001 }, (_, i) => i + 20000).filter(p => !occupied.has(p) && ranges.some(r => p >= r.start && p <= r.end));
}
function suggestPort(ports) { return ports.length ? ports[crypto.randomInt(ports.length)] : null; }
function validateRouter(input) {
  const ip = String(input.ip || '').trim();
  if (!net.isIP(ip)) throw new Error('Укажите IP-адрес роутера без протокола и порта');
  if (typeof input.password !== 'string' || !input.password.length || input.password.length > 512 || /[\r\n\0]/.test(input.password)) throw new Error('SSH-пароль: 1–512 символов, без переноса строки');
  const sshPort = Number(input.sshPort ?? 22);
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) throw new Error('Порт SSH: 1–65535');
  return { ip, password: input.password, sshPort };
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function routerScript(state, port) {
  const values = { SERVER: quote(state.host), SERVER_PORT: quote(state.port), TOKEN: quote(state.compatibilityMode ? '' : state.token), PORT: quote(port) };
  return fs.readFileSync(path.join(__dirname, 'installer/router.sh'), 'utf8').replace(/\r\n/g, '\n').replace(/@@(SERVER|SERVER_PORT|TOKEN|PORT)@@/g, (_, key) => values[key]);
}
function buildInstaller(state, port, input) {
  const config = { ...validateRouter(input), script: Buffer.from(routerScript(state, port)).toString('base64') };
  const payload = Buffer.from(JSON.stringify(config)).toString('base64');
  const ps = fs.readFileSync(path.join(__dirname, 'installer/windows.ps1'), 'utf8').replace('@@PAYLOAD@@', payload);
  // Only the fixed launcher is interpreted by cmd.exe. Credentials remain encoded data.
  return '@echo off\r\nsetlocal\r\nset "KV9_INSTALLER=%~f0"\r\npowershell.exe -NoLogo -NoProfile -Command "$env:PSModulePath=$PSHOME+\'\\Modules\'; $s=[IO.File]::ReadAllText($env:KV9_INSTALLER); & ([ScriptBlock]::Create($s.Substring($s.LastIndexOf(\'### POWERSHELL ###\')+18)))"\r\nset "result=%errorlevel%"\r\npause\r\nexit /b %result%\r\n### POWERSHELL ###\r\n' + ps.replace(/\r?\n/g, '\r\n');
}
module.exports = { availablePorts, suggestPort, validateRouter, routerScript, buildInstaller };
