const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const db = require('./database');
const { loadSettings } = require('./settings');

let publicKey = null;

const VAPID_STORE = process.env.VAPID_STORE || path.join(
  path.dirname(process.env.DB_PATH || path.join(__dirname, '../data/support.db')),
  'vapid.json'
);

function readStoredKeys() {
  try {
    if (!fs.existsSync(VAPID_STORE)) return null;
    const keys = JSON.parse(fs.readFileSync(VAPID_STORE, 'utf8'));
    if (keys?.publicKey && keys?.privateKey) return keys;
  } catch (e) {
    console.warn('[Push] Failed to read stored VAPID keys:', e.message);
  }
  return null;
}

function writeStoredKeys(keys) {
  try {
    fs.mkdirSync(path.dirname(VAPID_STORE), { recursive: true });
    fs.writeFileSync(VAPID_STORE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  } catch (e) {
    console.warn('[Push] Failed to persist generated VAPID keys:', e.message);
  }
}

function init() {
  let priv = process.env.VAPID_PRIVATE_KEY;
  publicKey = process.env.VAPID_PUBLIC_KEY;

  if (!publicKey || !priv) {
    const stored = readStoredKeys();
    if (stored) {
      publicKey = stored.publicKey;
      priv = stored.privateKey;
      console.log('[Push] Loaded persisted VAPID keys.');
    }
  }

  if (!publicKey || !priv) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    priv = keys.privateKey;
    writeStoredKeys(keys);
    console.warn('[Push] VAPID keys not found in .env — generated and saved to persistent data storage.');
    console.warn('[Push] You can also add them to .env:');
    console.warn(`VAPID_PUBLIC_KEY=${publicKey}`);
    console.warn(`VAPID_PRIVATE_KEY=${priv}`);
  }

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL || 'support@example.com'}`,
    publicKey,
    priv
  );
}

function getPublicKey() { return publicKey; }

async function send(ticketId, body) {
  if (!publicKey) return;
  const subs = db.getPushSubs.all(ticketId);
  const title = loadSettings().supportName || 'Поддержка';
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        JSON.parse(s.subscription),
        JSON.stringify({ title, body: body || 'Новое сообщение' })
      );
    } catch (e) {
      // 404/410 = subscription expired → delete it
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.delPushSub.run(s.id);
      }
    }
  }
}

module.exports = { init, getPublicKey, send };
