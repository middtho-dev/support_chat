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
    return proxies.find(p => p.type === 'tcp' && p.online && /luci|web|http/i.test(p.name)) ||
      proxies.find(p => p.type === 'tcp' && p.online && !/ssh/i.test(p.name)) || proxies.find(p => p.type === 'tcp' && p.online);
  }
  if (typeof module !== 'undefined') module.exports = { deviceUrl, primaryProxy };
  else root.FrpLinks = { deviceUrl, primaryProxy };
})(typeof window === 'undefined' ? {} : window);
