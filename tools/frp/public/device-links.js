(function (root) {
  'use strict';
  function deviceUrl(host, proxy) {
    if (!proxy || proxy.type !== 'tcp' || !Number.isInteger(Number(proxy.port)) || proxy.port < 1 || proxy.port > 65535) return null;
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:-]+$/.test(host)) return null;
    const hostname = host.includes(':') ? `[${host}]` : host;
    const protocol = /ssh/i.test(proxy.name) ? 'ssh' : /https/i.test(proxy.name) ? 'https' : 'http';
    try { return new URL(`${protocol}://${hostname}:${proxy.port}/`).href; } catch { return null; }
  }
  function primaryProxy(proxies) {
    return proxies.find(p => p.type === 'tcp' && p.online && /luci|web|http/i.test(p.name));
  }
  function groupDevices(proxies = [], clients = []) {
    const groups = new Map();
    const identity = c => c.clientID ? JSON.stringify([c.user || '', c.clientID]) : null;
    const baseName = name => String(name || '').replace(/[_ .-](?:luci|https?|web|ssh|tcp|udp)(?:[_-]?\d+)?$/i, '');
    for (const p of proxies) {
      const key = identity(p) || 'name:' + baseName(p.name);
      if (!groups.has(key)) groups.set(key, { key, ports: [], clients: [] });
      groups.get(key).ports.push(p);
    }
    for (const c of clients) {
      const key = identity(c) || 'client:' + c.key;
      // Old disconnected sessions without tunnels are connection history, not devices.
      if (!groups.has(key) && !c.online) continue;
      if (!groups.has(key)) groups.set(key, { key, ports: [], clients: [] });
      groups.get(key).clients.push(c);
    }
    return [...groups.values()].map(g => {
      const primary = primaryProxy(g.ports);
      const c = g.clients.find(c => c.online) || g.clients[0];
      const values = [...g.ports, ...g.clients];
      return { ...g, primary, name: baseName(primary?.name || g.ports[0]?.name) || c?.hostname || c?.user || c?.clientID || c?.key,
        ip: c?.ip || '', online: values.some(v => v.online), stale: values.some(v => v.stale),
        lastSeen: values.map(v => v.lastSeen || '').sort().at(-1) || '',
        connections: g.ports.reduce((sum, p) => sum + (Number(p.connections) || 0), 0) };
    }).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  }
  if (typeof module !== 'undefined') module.exports = { deviceUrl, primaryProxy, groupDevices };
  else root.FrpLinks = { deviceUrl, primaryProxy, groupDevices };
})(typeof window === 'undefined' ? {} : window);
