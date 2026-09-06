const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../public/js/storage');
const { installAdminGuard } = require('../src/admin-guard');
test('private or quota-limited browser storage keeps the app usable', () => {
  const s = createStorage(() => { throw new Error('Storage denied'); });
  s.setItem('draft', 'Текст'); assert.equal(s.getItem('draft'), 'Текст');
  s.removeItem('draft'); assert.equal(s.getItem('draft'), null);
  const quota = createStorage(() => ({ getItem: () => 'old', setItem() { throw Error('Quota'); }, removeItem() { throw Error('Denied'); } }));
  quota.setItem('draft', 'new'); assert.equal(quota.getItem('draft'), 'new');
  quota.removeItem('draft'); assert.equal(quota.getItem('draft'), null);
});
test('revoked realtime sessions leave the admin room and cannot dispatch actions', () => {
  let allowed = true, middleware, cleanup, forwarded = 0;
  const events = [];
  const socket = { isAdmin: true, adminCredential: 'session', use: fn => { middleware = fn; }, once: (_event, fn) => { cleanup = fn; }, leave: room => events.push(room), emit: event => events.push(event), disconnect: () => events.push('disconnect') };
  installAdminGuard(socket, token => allowed && token === 'session');
  try {
    middleware(['admin_reply', {}], () => forwarded++); assert.equal(forwarded, 1);
    middleware(['admin_reply', 'malformed'], () => forwarded++); assert.equal(forwarded, 1);
    allowed = false; middleware(['admin_reply', {}], () => forwarded++);
    assert.equal(forwarded, 1); assert.equal(socket.isAdmin, false);
    assert.deepEqual(events, ['admin', 'admin_auth_error', 'disconnect']);
  } finally { cleanup(); }
});
