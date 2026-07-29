const configuredMode = String(process.env.TELEGRAM_MODE || '').trim().toLowerCase();
const hasPrivateOperators = String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').some(value => value.trim());
const mode = configuredMode || (hasPrivateOperators ? 'private' : 'legacy');

if (!['private', 'legacy'].includes(mode)) {
  throw new Error(`Unsupported TELEGRAM_MODE "${mode}". Use "private" or "legacy".`);
}

module.exports = mode === 'private'
  ? require('./telegram-private')
  : require('./telegram-legacy');
