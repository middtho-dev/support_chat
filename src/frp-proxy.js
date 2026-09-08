'use strict';

// Only the trusted server knows the separate FRP service credential.
function createFrpProxy({ authorize, serviceUrl = process.env.FRP_SERVICE_URL || 'http://127.0.0.1:7400', serviceToken = process.env.FRP_SERVICE_TOKEN } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const access = authorize(req.get('x-admin-token'));
    if (!access.authenticated) return res.status(401).json({ error: 'Требуется вход в админку' });
    if (!access.canManageSettings) return res.status(403).json({ error: 'Нет прав на управление устройствами' });
    const suffix = req.path === '/' ? '' : req.path;
    if (!((req.method === 'GET' && suffix === '') || (req.method === 'POST' && /^\/(install|start|stop|configure|generate-installer|release-installer|revoke-installer|update-device|delete-device)$/.test(suffix)))) {
      return res.status(404).json({ error: 'Неизвестная операция' });
    }
    if (!serviceToken) return res.status(503).json({ error: 'Связь с FRP не настроена: задайте FRP_SERVICE_TOKEN на сервере' });
    try {
      const url = new URL('/api/admin/frp' + suffix, serviceUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid service URL');
      const response = await fetch(url, {
        method: req.method, redirect: 'error',
        headers: { 'x-admin-token': serviceToken, 'Content-Type': 'application/json' },
        ...(req.method === 'POST' ? { body: JSON.stringify(suffix === '/generate-installer' && process.env.PUBLIC_URL ? { ...req.body, enrollmentUrl: new URL('/api/frp/enroll', process.env.PUBLIC_URL).href } : req.body || {}) } : {}),
        signal: AbortSignal.timeout(suffix === '/install' ? 180000 : 30000)
      });
      if (response.status === 401) return res.status(503).json({ error: 'Ключ связи с FRP не совпадает. Проверьте FRP_SERVICE_TOKEN на сервере' });
      res.status(response.status).json(await response.json());
    } catch {
      res.status(502).json({ error: 'FRP временно недоступен. Проверьте запуск сервиса; чат продолжает работать' });
    }
  };
}
module.exports = { createFrpProxy };

// Installer capability authorizes only one device registration, never admin actions.
module.exports.createFrpEnrollmentProxy = function ({ serviceUrl = process.env.FRP_SERVICE_URL || 'http://127.0.0.1:7400' } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!/^Bearer [a-f0-9]{64}$/.test(req.get('authorization') || '')) return res.status(401).json({ error: 'Недействительный файл установки' });
    try {
      const response = await fetch(new URL('/api/frp/enroll', serviceUrl), { method: 'POST', redirect: 'error', headers: { Authorization: req.get('authorization'), 'Content-Type': 'application/json' }, body: JSON.stringify({ fingerprint: req.body?.fingerprint, operation: req.body?.operation }), signal: AbortSignal.timeout(20000) });
      res.status(response.status).json(await response.json());
    } catch { res.status(502).json({ error: 'Сервер регистрации временно недоступен' }); }
  };
};
