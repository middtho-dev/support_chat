'use strict';
function installAdminGuard(socket, authorize) {
  function check() {
    if (!socket.isAdmin || authorize(socket.adminCredential)) return true;
    socket.isAdmin = false;
    socket.adminCredential = null;
    socket.leave('admin');
    socket.emit('admin_auth_error', { message: 'Сессия истекла или доступ отозван' });
    socket.disconnect(true);
    return false;
  }
  socket.use((packet, next) => {
    const [event, payload] = packet;
    if (typeof event !== 'string') return;
    if (event.startsWith('admin_') && event !== 'admin_auth' && (!check() || !socket.isAdmin)) return;
    // Object events must not crash handlers when a malformed packet is sent.
    if (payload === null) packet[1] = {};
    else if (payload !== undefined && typeof payload !== 'function' && (typeof payload !== 'object' || Array.isArray(payload))) return;
    next();
  });
  const timer = setInterval(check, 1000);
  timer.unref();
  socket.once('disconnect', () => clearInterval(timer));
  return check;
}
module.exports = { installAdminGuard };
