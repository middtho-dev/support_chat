# Telegram webhook deployment

Support and Voice use independent durable inboxes and separate bot tokens.
Public HTTPS terminates at Caddy. Do not expose internal service ports.

Support `.env`:

```dotenv
TELEGRAM_WEBHOOK_URL=https://helpo.su/api/webhooks/telegram/support
TELEGRAM_WEBHOOK_SECRET=<random 32–256 characters: A-Z a-z 0-9 _ ->
```

Voice `tools/voice/.env`:

```dotenv
VOICE_WEBHOOK_URL=https://helpo.su/api/webhooks/telegram/voice
VOICE_WEBHOOK_SECRET=<different random secret>
```

Add a specific Caddy route before the catch-all support upstream:

```caddy
reverse_proxy /api/webhooks/telegram/voice 127.0.0.1:7500
```

Validate and reload Caddy before restarting the services. Each bot registers its
own URL without dropping pending updates. Another existing webhook is rejected;
do not silently take over a bot used by another application. Use one service
instance for each inbox volume. The support runtime lease remains in use.

## Delivery contract

- Reject incorrect Telegram secret headers before reading the request body.
- HTTP 200 only follows an atomic, fsynced inbox write. Storage failure returns
  503 so Telegram retries. Body limit: 1 MiB; pending limit: 10,000 events.
- Inbox namespaces derive from bot-token hashes; changing bots cannot replay
  old bot events into the new account.
- Deduplicate update IDs, retain completed IDs for seven days, and remove message
  content when completed. Processing errors retry with capped backoff.
- Voice ingests into its existing persistent job store. Support messages hand
  off to the existing SQLite incoming queue, which owns delivery retries.
- State survives process restarts. This is at-least-once processing, not a claim
  of exactly-once remote effects: a crash after a Telegram action but before local
  acknowledgement can require reconciliation. Unconfirmed Voice sends remain
  visible as uncertain; they are not blindly resent. Explicit Telegram 429
  responses retry according to retry_after.
- Disabled modules retain incoming events; their existing filters and activation
  times still determine which messages should be processed on reactivation.

## Diagnostics and rollback

Support status includes `transport` with mode, pending count, oldest event,
last received time (since process start), and a redacted processing error.
Voice exposes the same fields in its authenticated status and panel.
Check Telegram getWebhookInfo for pending_update_count and last_error_message;
an HTTP health response alone does not prove successful Telegram delivery.

To roll back: stop the affected service, call deleteWebhook with
drop_pending_updates=false, remove its WEBHOOK_URL, and restart in polling mode.
Do not run polling and webhook consumers concurrently. Preserve the data volume
and reconcile any already accepted inbox events before abandoning webhook mode.

## Verification checklist

- [x] Persistence before ACK; storage failure returns 503.
- [x] Authentication and malformed request rejection.
- [x] Restart recovery, duplicate update, retry and content removal tests.
- [x] Refuse foreign webhook, retain Telegram pending updates.
- [ ] Production registration and HTTPS route check for both bots.
- [ ] Real customer chat, operator reply and Business voice round trip.

Webhooks affect incoming Telegram events only. Socket.IO session recovery,
ticket inactivity rules, FRP status and Lampac playback telemetry remain separate
subsystems; do not diagnose them solely from webhook health.
