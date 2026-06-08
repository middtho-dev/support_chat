# Production deploy

## First install

```bash
git clone https://github.com/middtho-dev/support_chat.git
cd support_chat
cp .env.example .env
nano .env
sudo bash setup.sh
```

`ADMIN_TOKEN`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_GROUP_ID` are required.

For Telegram Mini App admin access, set one of these:

```env
PUBLIC_URL=https://your-domain.example
TELEGRAM_ADMIN_IDS=123456789
# or, if the admin panel has a custom URL:
TELEGRAM_WEBAPP_URL=https://your-domain.example/admin?tg=1
```

`TELEGRAM_ADMIN_IDS` is a comma-separated list of Telegram user IDs allowed to open the admin Mini App. Get your ID from @userinfobot. After restart, `/admin` in the Telegram support group opens the admin panel as a Mini App button only for allowed users.

## Safe update

Use this when the server has no local code edits:

```bash
cd /home/ubuntu/support_chat
git pull --rebase origin main
sudo bash update.sh
```

If `git pull` says that local changes would be overwritten, save them first:

```bash
cd /home/ubuntu/support_chat
git status --short
git stash push -u -m "server-local-before-update"
git pull --rebase origin main
sudo bash update.sh
```

## Verify after update

```bash
docker compose config >/dev/null && echo COMPOSE_OK
docker exec support-chat sh -lc 'wget -qO- http://localhost:${PORT:-3001}/health'
docker exec support-chat sh -lc 'test -n "$ADMIN_TOKEN" && echo ADMIN_TOKEN_OK'
docker logs support-chat --tail=40
```

In the `/health` JSON, check `telegram.miniAppConfigured: true` and `telegram.miniAppAllowedAdmins` greater than `0`. If `miniAppConfigured` is `false`, add `PUBLIC_URL` or `TELEGRAM_WEBAPP_URL` to `.env`; if `miniAppAllowedAdmins` is `0`, add `TELEGRAM_ADMIN_IDS`. Then run `sudo bash update.sh`.

## Notes

- `update.sh` does not rewrite `.env`.
- If VAPID keys are not present in `.env`, the app stores generated keys in `/app/data/vapid.json`, which is backed by the `support-data` Docker volume.
- `docker compose down` does not delete the data or upload volumes. Do not run `docker compose down -v` in production unless you intentionally want to remove stored chat data and uploads.
