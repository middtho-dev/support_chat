const webpush = require('web-push');
const db = require('./database');

let publicKey = null;

function init() {
  publicKey  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;

  if (!publicKey || !priv) {
    const keys = webpush.generateVAPIDKeys();
    publicKey = keys.publicKey;
    console.warn('[Push] VAPID keys not found in .env — generated for this session.');
    console.warn('[Push] Add to .env to persist across restarts:');
    console.warn(`VAPID_PUBLIC_KEY=${publicKey}`);
    console.warn(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
    webpush.setVapidDetails(
      `mailto:${process.env.VAPID_EMAIL || 'support@example.com'}`,
      publicKey, keys.privateKey
    );
  } else {
    webpush.setVapidDetails(
      `mailto:${process.env.VAPID_EMAIL || 'support@example.com'}`,
      publicKey, priv
    );
  }
}

function getPublicKey() { return publicKey; }

async function send(ticketId, body) {
  if (!publicKey) return;
  const subs = db.getPushSubs.all(ticketId);
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        JSON.parse(s.subscription),
        JSON.stringify({ title: 'Поддержка KV9RU', body: body || 'Новое сообщение' })
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
