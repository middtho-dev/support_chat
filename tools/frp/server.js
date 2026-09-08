'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFrp } = require('./manager');

function authorized(value, token) {
  if (typeof value !== 'string' || !token) return false;
  const a = crypto.createHash('sha256').update(value).digest();
  const b = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(a, b);
}

function createServer(manager, token) {
  const assets = { '/': ['index.html', 'text/html'], '/device-links.js': ['device-links.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/panel.css': ['panel.css', 'text/css; charset=utf-8'], '/style.css': ['style.css', 'text/css'] };
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') return json(200, { ok: true });
    if (assets[url.pathname] && req.method === 'GET') {
      const [file, type] = assets[url.pathname];
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
    }
    if (!url.pathname.startsWith('/api/admin/frp')) return json(404, { error: 'Not found' });
    if (!authorized(req.headers['x-admin-token'], token)) return json(401, { error: 'Неверный ключ панели' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/admin/frp') return json(200, await manager.status());
      const action = url.pathname.match(/^\/api\/admin\/frp\/(install|start|stop|configure|generate-installer|release-installer)$/)?.[1];
      if (req.method !== 'POST' || !action) return json(404, { error: 'Not found' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(415, { error: 'Expected JSON' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 4096) return json(413, { error: 'Request too large' }); }
      return json(200, await manager.action(action, JSON.parse(body || '{}')));
    } catch (e) { json(400, { error: e.message }); }
  });
}

if (require.main === module) {
  const token = process.env.FRP_ADMIN_TOKEN;
  if (!token || token.length < 24 || token.startsWith('replace-with-')) throw new Error('Задайте отдельный FRP_ADMIN_TOKEN (не менее 24 символов)');
  const manager = createFrp();
  const server = createServer(manager, token);
  manager.init().then(() => server.listen(Number(process.env.FRP_PANEL_PORT || 7400), process.env.FRP_PANEL_HOST || '127.0.0.1', () => console.log('[FRP panel] Ready')));
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
    await manager.shutdown();
    server.close(() => { clearTimeout(timeout); process.exit(0); });
    server.closeIdleConnections();
  }
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}

module.exports = { createServer, authorized };
