'use strict';

// Bot API cannot enumerate chat history. Persist message IDs, never message text.
module.exports = function createChatCleanup(sql, authorized) {
  sql.exec(`CREATE TABLE IF NOT EXISTS telegram_operator_chat_log (
    chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, sent_at INTEGER NOT NULL,
    PRIMARY KEY(chat_id,message_id)
  )`);
  const record = sql.prepare('INSERT OR IGNORE INTO telegram_operator_chat_log VALUES (?,?,?)');
  const forget = sql.prepare('DELETE FROM telegram_operator_chat_log WHERE chat_id=? AND message_id=?');
  const prune = sql.prepare('DELETE FROM telegram_operator_chat_log WHERE sent_at < ?');
  let lastPrune=0;
  function track(chatId, message) {
    if (!authorized(String(chatId)) || !Number.isSafeInteger(message?.message_id)) return;
    try {
      const now=Math.floor(Date.now()/1000);
      if(now-lastPrune>3600){prune.run(now-48*3600);lastPrune=now;}
      record.run(String(chatId), message.message_id, message.date || now);
    } catch(error) {
      // A journal failure must not turn a delivered reply into a send failure/retry.
      console.warn('[TG cleanup] message ID journal unavailable:',error.code || 'database error');
    }
  }
  function attach(bot) {
    for (const method of ['sendMessage','sendRichMessage','sendPhoto','sendVideo','sendAudio','sendDocument','sendMediaGroup']) {
      if (typeof bot[method] !== 'function') continue;
      const send = bot[method].bind(bot);
      bot[method] = async (chatId,...args) => {
        const result = await send(chatId,...args);
        for (const message of Array.isArray(result) ? result : [result]) track(chatId,message);
        return result;
      };
    }
  }
  const candidates = sql.prepare(`
    SELECT message_id FROM telegram_operator_chat_log WHERE chat_id=@chat AND sent_at>@cutoff
    UNION SELECT message_id FROM telegram_ticket_notifications WHERE chat_id=@chat AND created_at>datetime(@cutoff,'unixepoch')
    UNION SELECT message_id FROM telegram_ticket_reminders WHERE chat_id=@chat AND created_at>datetime(@cutoff,'unixepoch')
    UNION SELECT root_message_id FROM telegram_ticket_threads WHERE chat_id=@chat AND created_at>datetime(@cutoff,'unixepoch')
    UNION SELECT telegram_message_id FROM messages WHERE telegram_chat_id=@chat AND created_at>datetime(@cutoff,'unixepoch')
    UNION SELECT telegram_source_message_id FROM messages WHERE telegram_source_chat_id=@chat AND created_at>datetime(@cutoff,'unixepoch')
    ORDER BY message_id DESC
  `);
  const busy = new Set();
  async function clear(bot, chatId, keepId) {
    const chat=String(chatId);
    if (!authorized(chat) || !Number.isSafeInteger(keepId) || busy.has(chat)) throw new Error('Очистка недоступна или уже выполняется');
    busy.add(chat);
    try {
      const cutoff=Math.floor(Date.now()/1000)-48*3600;
      prune.run(cutoff);
      const ids=candidates.all({chat,cutoff}).map(row=>row.message_id).filter(id=>Number.isSafeInteger(id)&&id>0&&id!==keepId);
      let removed=0,failed=0;
      for (const id of ids) {
        try { await bot.deleteMessage(chat,id); removed++; forget.run(chat,id); }
        catch(error) {
          const description=String(error?.response?.body?.description || error.message || error);
          if (/message to delete not found|message_id_invalid/i.test(description)) {forget.run(chat,id);continue;}
          failed++;
          // Do not flood Telegram when rate-limited or offline. Remaining IDs can be retried.
          if (/429|too many requests|EFATAL|ETIMEDOUT|ECONN/i.test(description)) {failed+=ids.length-removed-failed;break;}
        }
      }
      return {removed,failed};
    } finally {busy.delete(chat);}
  }
  return {track,attach,clear};
};
