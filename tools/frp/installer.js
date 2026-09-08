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
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function routerScript(state, port) {
  const values = { SERVER: quote(state.host), SERVER_PORT: quote(state.port), TOKEN: quote(state.compatibilityMode ? '' : state.token), PORT: quote(port) };
  return fs.readFileSync(path.join(__dirname, 'installer/router.sh'), 'utf8').replace(/\r\n/g, '\n').replace(/@@(SERVER|SERVER_PORT|TOKEN|PORT)@@/g, (_, key) => values[key]);
}
function buildInstaller(config) {
  const payload = Buffer.from(JSON.stringify(config)).toString('base64');
  const ps = fs.readFileSync(path.join(__dirname, 'installer/windows.ps1'), 'utf8').replace('@@PAYLOAD@@', payload);
  // Only the fixed launcher is interpreted by cmd.exe. Credentials remain encoded data.
  return '@echo off\r\nsetlocal\r\nset "KV9_INSTALLER=%~f0"\r\npowershell.exe -NoLogo -NoProfile -Command "$env:PSModulePath=$PSHOME+\'\\Modules\'; $s=[IO.File]::ReadAllText($env:KV9_INSTALLER); & ([ScriptBlock]::Create($s.Substring($s.LastIndexOf(\'### POWERSHELL ###\')+18)))"\r\nset "result=%errorlevel%"\r\nexit /b %result%\r\n### POWERSHELL ###\r\n' + ps.replace(/\r?\n/g, '\r\n');
}
module.exports = { availablePorts, suggestPort, routerScript, buildInstaller };
