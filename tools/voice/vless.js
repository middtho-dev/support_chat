'use strict';

// Only supported share-link parameters are accepted: never silently drop transport options.
function parseVless(link) {
  let u;
  try { u = new URL(link); } catch { throw Error('Нужна полная ссылка vless://'); }
  if (u.protocol !== 'vless:' || !u.hostname || u.password || (u.pathname && u.pathname !== '/')) throw Error('Некорректная ссылка VLESS');
  const id = decodeURIComponent(u.username);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw Error('В ссылке VLESS нужен UUID пользователя');
  const port = Number(u.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Некорректный порт VLESS');
  const q = u.searchParams;
  const supported = ['encryption','security','type','flow','sni','fp','pbk','sid','spx','alpn','host','path','serviceName','mode','headerType'];
  for (const key of q.keys()) if (!supported.includes(key)) throw Error('Неподдерживаемый параметр VLESS: '+key.slice(0,40));
  if (q.get('encryption') && q.get('encryption') !== 'none') throw Error('Поддерживается VLESS encryption=none с TLS или REALITY');
  const network = ({raw:'tcp',websocket:'ws'})[q.get('type')] || q.get('type') || 'tcp';
  if (!['tcp','ws','grpc','xhttp','httpupgrade'].includes(network)) throw Error('Поддерживаются TCP, WS, gRPC, XHTTP и HTTPUpgrade');
  if (q.get('headerType') && q.get('headerType') !== 'none') throw Error('TCP headerType поддерживается только none');
  const security = q.get('security') || 'none';
  if (!['tls','reality'].includes(security)) throw Error('Для VLESS требуется security=tls или reality');
  const flow = q.get('flow') || '';
  if (flow && (flow !== 'xtls-rprx-vision' || network !== 'tcp')) throw Error('XTLS Vision поддерживается только для TCP');
  const streamSettings = {network,security};
  const serverName = q.get('sni') || u.hostname.replace(/^\[|\]$/g,'');
  if (security === 'reality') {
    if (!['tcp','grpc','xhttp'].includes(network)) throw Error('REALITY не поддерживает этот транспорт');
    if (!/^[\w-]{43}$/.test(q.get('pbk') || '')) throw Error('В REALITY нужен публичный ключ pbk');
    const shortId = q.get('sid') || '';
    if (!/^(?:[a-f0-9]{2}){0,8}$/i.test(shortId)) throw Error('Некорректный sid REALITY');
    streamSettings.realitySettings = {serverName,fingerprint:q.get('fp')||'chrome',publicKey:q.get('pbk'),shortId,spiderX:q.get('spx')||'/'};
  } else streamSettings.tlsSettings = {serverName,allowInsecure:false,...(q.get('fp')?{fingerprint:q.get('fp')}:{}),...(q.get('alpn')?{alpn:q.get('alpn').split(',')}: {})};
  const host=q.get('host')||'',path=q.get('path')||'/';
  if (network==='ws') streamSettings.wsSettings={path,...(host?{headers:{Host:host}}:{})};
  if (network==='httpupgrade') streamSettings.httpupgradeSettings={path,host};
  if (network==='grpc') {
    if (q.get('mode')&&!['gun','multi'].includes(q.get('mode'))) throw Error('gRPC mode: gun или multi');
    streamSettings.grpcSettings={serviceName:q.get('serviceName')||'',multiMode:q.get('mode')==='multi'};
  }
  if (network==='xhttp') {
    const mode=q.get('mode')||'auto';
    if (!['auto','packet-up','stream-up','stream-one'].includes(mode)) throw Error('Некорректный XHTTP mode');
    streamSettings.xhttpSettings={path,host,mode};
  }
  return {protocol:'vless',settings:{vnext:[{address:u.hostname.replace(/^\[|\]$/g,''),port,users:[{id,encryption:'none',flow}]}]},streamSettings};
}

function xrayConfig(link, port, password) {
  return {
    log:{loglevel:'none'},
    inbounds:[{listen:'127.0.0.1',port,protocol:'http',settings:{accounts:[{user:'voice',pass:password}]}}],
    outbounds:[{tag:'block',protocol:'blackhole'},{tag:'vpn',...parseVless(link)}],
    routing:{rules:[{type:'field',domain:['full:api.openai.com','full:api.telegram.org'],port:'443',outboundTag:'vpn'}]}
  };
}
module.exports={parseVless,xrayConfig};
