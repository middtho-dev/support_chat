'use strict';
const net = require('net');
const dns = require('dns').promises;
function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname : ''; }
  catch { return ''; }
}
function createDeploymentInfo({ authorize, env = process.env, fetcher = fetch, resolver = dns } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const access = authorize(req.get('x-admin-token'));
    if (!access.authenticated) return res.status(401).json({ error: 'Требуется вход' });
    if (!access.canManageSettings) return res.status(403).json({ error: 'Нужны права управления' });
    const publicUrl = safeUrl(env.PUBLIC_URL), miniapp = safeUrl(env.TELEGRAM_WEBAPP_URL) || (publicUrl ? publicUrl.replace(/\/$/, '') + '/miniapp' : '');
    const ipv4 = net.isIP(env.PUBLIC_SERVER_IPV4 || '') === 4 ? env.PUBLIC_SERVER_IPV4 : '';
    const ipv6 = net.isIP(env.PUBLIC_SERVER_IPV6 || '') === 6 ? env.PUBLIC_SERVER_IPV6 : '';
    let frp = null;
    if (env.FRP_SERVICE_TOKEN) try {
      const r = await fetcher(new URL('/api/admin/frp', env.FRP_SERVICE_URL || 'http://127.0.0.1:7400'), { headers: { 'x-admin-token': env.FRP_SERVICE_TOKEN }, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (r.ok) { const c = await r.json(); if (c?.host) frp = { host: c.host, port: c.port, portStart: c.portStart, portEnd: c.portEnd, reservedPorts: c.reservedPorts }; }
    } catch {}
    const hosts = [...new Set([publicUrl, miniapp].filter(Boolean).map(u => new URL(u).hostname).concat(frp?.host || []).filter(h => h && !net.isIP(h)))];
    async function lookup(host, type) {
      let timer;
      try { return await Promise.race([resolver[type](host), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 3000); })]); }
      catch (e) { return ['ENODATA', 'ENOTFOUND'].includes(e.code) ? [] : null; }
      finally { clearTimeout(timer); }
    }
    const records = await Promise.all(hosts.map(async host => ({ host, a: await lookup(host, 'resolve4'), aaaa: await lookup(host, 'resolve6') })));
    res.json({ ipv4, ipv6, publicUrl, miniapp, repository: safeUrl(env.REPOSITORY_URL), frp, records, internal: { chat: `127.0.0.1:${Number(env.PORT) || 3001}`, frp: safeUrl(env.FRP_SERVICE_URL || 'http://127.0.0.1:7400'), voice: safeUrl(env.VOICE_SERVICE_URL || 'http://127.0.0.1:7500') }, checkedAt: new Date().toISOString() });
  };
}
module.exports = { createDeploymentInfo, safeUrl };
