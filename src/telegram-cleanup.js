'use strict';
// A queue entry is never younger than its original Telegram message.
function cleanupExpired(createdAt, now = Date.now()) {
  const date = Date.parse(String(createdAt || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(date) && now - date >= 48 * 60 * 60 * 1000;
}
function permanentDeletionError(message) {
  return /message (?:can't|cannot) be deleted|message_delete_forbidden|not enough rights to delete/i.test(message);
}
module.exports = { cleanupExpired, permanentDeletionError };
