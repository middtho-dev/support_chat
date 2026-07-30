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

Expected values in the `/health` response:

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
and that `unassignedTickets` does not keep growing. Delivery failures and retry
counters are available under `telegram.delivery`. Backup, cleanup and disk
thresholds are configured in the admin UI; only `BACKUP_DIR` remains a
server-controlled path.

## Notes

- `update.sh` never rewrites `.env`.
- Generated VAPID keys are stored in `/app/data/vapid.json`.
- Database and uploads live in Docker volumes.
- `docker compose down` preserves volumes; `docker compose down -v` deletes
  them and must not be used for a normal update.
