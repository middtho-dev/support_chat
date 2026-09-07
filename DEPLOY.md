# Production deploy

## First install

Before deployment, create a bot with
[@BotFather](https://t.me/BotFather), enable **Threaded Mode** for it, and
collect the numeric Telegram user IDs of all operators.

```bash
git clone https://github.com/middtho-dev/support_chat.git
cd support_chat
sudo bash setup.sh
```

The installer creates the private-mode configuration:

```env
TELEGRAM_BOT_TOKEN=123456:token
TELEGRAM_MODE=private
TELEGRAM_ADMIN_IDS=123456789,987654321
ADMIN_TOKEN=a-long-random-token
PUBLIC_URL=https://support.example.com
```

After the container starts, every ID listed in `TELEGRAM_ADMIN_IDS` must open a
private chat with the bot and send `/start`. This registers the operator and
allows the bot to create per-ticket private topics. No Telegram group is needed.
Users not listed in `TELEGRAM_ADMIN_IDS` can contact support through the same
private bot chat. Their first message creates a Telegram-source ticket, while
operator replies are delivered back to that chat. This channel and its texts
are controlled in the admin settings without restarting the container.

`PUBLIC_URL` enables the Mini App button. Set `TELEGRAM_WEBAPP_URL` only when
the Mini App uses a different HTTPS URL.

## Upgrade from group topics

Back up the database first:

```bash
docker cp support-chat:/app/data/support.db ./support-before-private.db
```

Update `.env`:

```env
TELEGRAM_MODE=private
TELEGRAM_ADMIN_IDS=123456789,987654321
```

`TELEGRAM_GROUP_ID` is ignored in private mode and may be removed. Then enable
Threaded Mode in @BotFather and run:

```bash
git pull --rebase origin main
sudo bash update.sh
```

The SQLite migration is automatic and preserves existing tickets and messages.
Old group topic IDs remain only for emergency compatibility. To roll back
temporarily, set `TELEGRAM_MODE=legacy` and restore `TELEGRAM_GROUP_ID`.

## Safe update

Use this when the server has no local code edits:

```bash
cd /home/ubuntu/support_chat
git pull --rebase origin main
sudo bash update.sh
```

If local changes block the pull, save them before updating:

```bash
git status --short
git stash push -u -m "server-local-before-update"
git pull --rebase origin main
sudo bash update.sh
```

## Verify after update

```bash
docker compose config >/dev/null && echo COMPOSE_OK
docker exec support-chat sh -lc 'wget -qO- http://localhost:${PORT:-3001}/health'
docker logs support-chat --tail=60
```

The public `/health` response intentionally contains only readiness and the
deployed version. Open **Состояние системы** in the authenticated admin panel,
or request the detailed endpoint with the admin token:

```bash
curl -fsS -H "X-Admin-Token: $ADMIN_TOKEN" https://support.example.com/api/admin/health
```

Expected Telegram values in that authenticated response:

```json
{
  "telegram": {
    "mode": "private",
    "configured": true,
    "connected": true,
    "threadedModeEnabled": true,
    "richMessagesAvailable": true
  },
  "maintenance": {
    "healthy": true
  }
}
```

Also verify that `registeredOperators` matches the operators who sent `/start`,
that `unassignedTickets` does not keep growing, and that
`customerChannelEnabled` is `true`. Delivery failures and separate customer
reply retry counters are available under `telegram.delivery`. The
`pendingIncomingMessages` counter covers Telegram updates that are waiting for
durable retry after a file or network failure. Backup, cleanup, Telegram
customer behavior, and disk thresholds are configured in the admin UI; only
`BACKUP_DIR` remains a server-controlled path.

## Notes

- `update.sh` never rewrites `.env`.
- Generated VAPID keys are stored in `/app/data/vapid.json`.
- Database and uploads live in Docker volumes.
- `docker compose down` preserves volumes; `docker compose down -v` deletes
  them and must not be used for a normal update.
# Production addresses and migration

The production checkout is `/root/support_chat` on `31.76.127.223`.
Git pushes originate there using `/root/.ssh/github_support_chat`, a write deploy
key scoped to this repository. The private key stays on the server. GitHub PR
management can use an authenticated administrator workstation.

In **Управление → Домены и адреса**, managers can inspect the server IPv4/IPv6,
panel and Mini App URLs, current FRP host/ports, and actual A/AAAA answers.
The page is informational and does not modify DNS. It reads `PUBLIC_SERVER_IPV4`,
`PUBLIC_SERVER_IPV6`, `PUBLIC_URL`, `TELEGRAM_WEBAPP_URL`, and `REPOSITORY_URL`
from the root `.env`; FRP settings are read from the running FRP service.
Restart the chat container after changing environment variables. Keys and
credentials are excluded from the inventory.

For the current deployment, point the A records for `helpo.su` and
`router.kv9.ru` to `31.76.127.223`. Inspect AAAA records as well: do not leave an
old IPv6 destination, and only publish a new IPv6 address after verifying HTTPS
and FRP over IPv6. Keep FRP records in DNS-only mode when using a CDN that does
not proxy arbitrary TCP/UDP ports. Device configurations keep their existing
domain and ports. DNS TTL and client caching affect reconnection time.

During migration, first copy the repository, `.env` files, all five Docker data
volumes and Caddy certificates. Stop all source application containers before
the final volume synchronization; start only the destination containers.
The previous host can temporarily relay HTTP/HTTPS and FRP traffic while DNS
propagates. Do not run both Telegram pollers or accept writes into both databases.
Remove the old relay only after DNS and device reconnections are verified.
