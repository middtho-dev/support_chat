'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Each module owns its inbox. Acknowledgements follow an atomic, flushed write.
class WebhookInbox {
  constructor({dir, secret, handle, ready = () => true, partition}) {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(secret || '')) throw Error('Webhook secret must contain 32–256 safe characters');
    this.dir = dir; this.secret = secret; this.handle = handle; this.ready = ready; this.partition = partition;
    this.busy = false; this.lastError = ''; this.lastReceivedAt = null;
    fs.mkdirSync(dir, {recursive:true, mode:0o700});
    this.timer = setInterval(() => this.drain().catch(() => { this.lastError = 'Inbox storage unavailable'; }), 1000);
    this.timer.unref();
  }
  write(file, value) {
    const temp = file + '.tmp';
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(this.dir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  }
  accept(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw Error('Invalid update');
    const file = path.join(this.dir, update.update_id + '.json');
    if (fs.existsSync(file)) return;
    if (this.status().pending >= 10000) throw Error('Inbox full');
    this.write(file, {update, created:Date.now(), attempts:0, next:0});
    this.lastReceivedAt = new Date().toISOString();
    setImmediate(() => this.drain().catch(() => { this.lastError = 'Inbox storage unavailable'; }));
  }
  files() { return fs.readdirSync(this.dir).filter(f => /^\d+\.json$/.test(f)).sort((a,b) => parseInt(a)-parseInt(b)); }
  async receive(req, res) {
    const send = code => { res.statusCode = code; res.end(); };
    if (req.method !== 'POST') return send(405);
    const supplied = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] || ''));
    const expected = Buffer.from(this.secret);
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return send(403);
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024*1024) return send(413); chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString('utf8');
      let update; try { update = JSON.parse(body); } catch { return send(400); }
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) return send(400);
      this.accept(update); send(200);
    } catch { this.lastError = 'Could not persist incoming update'; send(503); }
  }
  async drain() {
    if (this.busy || !this.ready()) return;
    this.busy = true;
    try {
      const blocked = new Set();
      for (const name of this.files()) {
        if (!this.ready()) break;
        const file = path.join(this.dir, name), item = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (item.done) { if (item.done < Date.now()-7*86400000) fs.unlinkSync(file); continue; }
        const update = item.update;
        const message = update.message || update.business_message || update.callback_query?.message;
        const key = this.partition ? String(this.partition(update)) : String(message?.chat?.id || update.business_connection?.id || update.deleted_business_messages?.chat?.id || 'other');
        if (blocked.has(key)) continue;
        if (item.next > Date.now()) { blocked.add(key); continue; }
        try {
          await this.handle(item.update);
          this.write(file, {done:Date.now()}); this.lastError = '';
        } catch {
          blocked.add(key);
          item.attempts++; item.next = Date.now()+Math.min(300000, 1000*2**Math.min(item.attempts,8));
          this.write(file, item); this.lastError = 'Update processing failed; retry scheduled';
        }
      }
    } finally { this.busy = false; }
  }
  status() {
    let pending = 0, oldest = null;
    for (const name of this.files()) { const row = JSON.parse(fs.readFileSync(path.join(this.dir,name),'utf8')); if (!row.done) { pending++; oldest = oldest === null ? row.created : Math.min(oldest,row.created); } }
    return {mode:'webhook', pending, oldestAt:oldest, lastReceivedAt:this.lastReceivedAt, error:this.lastError};
  }
  stop() { clearInterval(this.timer); this.ready = () => false; }
}

async function registerWebhook(call, url, secret, allowed_updates) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw Error('Webhook requires a plain HTTPS URL');
  const current = await call('getWebhookInfo', {});
  if (current.url && current.url !== url) throw Error('Bot already uses another webhook; migration requires an explicit decision');
  await call('setWebhook', {url, secret_token:secret, allowed_updates, max_connections:1, drop_pending_updates:false});
}
module.exports = {WebhookInbox, registerWebhook};
