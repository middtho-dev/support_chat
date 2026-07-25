#!/bin/bash
# Обновление без переустановки Caddy и .env
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║        Support Chat — Обновление         ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

[ -f ".env" ] || err ".env не найден. Сначала запустите setup.sh"
command -v docker >/dev/null 2>&1 || err "Docker не установлен"
docker compose version >/dev/null 2>&1 || err "Docker Compose недоступен"

# Проверка обязательных переменных
set -a
source .env
set +a

[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || err "В .env не задан TELEGRAM_BOT_TOKEN"
[ -n "${TELEGRAM_GROUP_ID:-}" ] || err "В .env не задан TELEGRAM_GROUP_ID"
[ -n "${ADMIN_TOKEN:-}" ] || err "В .env не задан ADMIN_TOKEN (админ-панель не будет доступна)"
[ -n "${TELEGRAM_ADMIN_IDS:-}" ] || warn "TELEGRAM_ADMIN_IDS не задан — Telegram Mini App не пустит админа без ручного ADMIN_TOKEN"

# setup.sh создаёт Caddyfile, но старые установки могут всё ещё кэшировать JS на год.
# Обновляем только наш известный cache-блок, не перезаписывая пользовательскую конфигурацию Caddy.
if command -v caddy >/dev/null 2>&1 && [ -f /etc/caddy/Caddyfile ]; then
  info "Обновляю правила кэша Caddy..."
  python3 - <<'PY'
from pathlib import Path
import re

path = Path('/etc/caddy/Caddyfile')
text = path.read_text()
old = re.compile(r'\n\s*@static path /css/\* /js/\* /uploads/\*\n\s*header @static Cache-Control "public, max-age=31536000, immutable"')
new = '''
    @fresh path / /index.html /admin /admin.html /miniapp /tg-admin /js/* /sw.js /manifest.json
    header @fresh Cache-Control "no-cache, must-revalidate"

    @static path /css/* /logo.png
    header @static Cache-Control "public, max-age=86400"

    @uploads path /uploads/*
    header @uploads Cache-Control "public, max-age=604800"'''
updated, count = old.subn('\n' + new, text)
old_log = re.compile(r'''\n\s*log \{\n\s*output file /var/log/caddy/access\.log \{\n\s*roll_size 10mb\n\s*roll_keep 5\n\s*\}\n\s*\}''')
updated, log_count = old_log.subn('\n    log {\n        output stdout\n    }', updated)
if count or log_count:
    path.write_text(updated)
PY
  caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null
  caddy validate --config /etc/caddy/Caddyfile >/dev/null
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy
  else
    systemctl restart caddy
  fi
  log "Конфигурация Caddy обновлена и перезагружена"
fi

info "Проверяю docker-compose.yml и .env..."
docker compose config >/dev/null
log "Конфигурация Docker Compose корректна"

if [ -z "${VAPID_PUBLIC_KEY:-}" ] || [ -z "${VAPID_PRIVATE_KEY:-}" ]; then
  warn "VAPID ключи не заданы в .env — приложение сохранит их в Docker volume автоматически"
fi
if [ -z "${PUBLIC_URL:-}" ] && [ -z "${TELEGRAM_WEBAPP_URL:-}" ]; then
  warn "PUBLIC_URL/TELEGRAM_WEBAPP_URL не заданы — Telegram Mini App для админки не будет настроен"
fi

info "Останавливаю контейнер..."
docker compose down --remove-orphans

info "Пересобираю образ..."
docker compose build --no-cache

info "Запускаю контейнер..."
docker compose up -d --remove-orphans

info "Жду готовность приложения..."
PORT_TO_CHECK="${PORT:-3001}"
for i in {1..30}; do
  if docker ps --filter "name=^/support-chat$" --filter "status=running" --format '{{.Names}}' | grep -qx "support-chat"; then
    if docker exec support-chat sh -lc "wget -qO- http://127.0.0.1:${PORT_TO_CHECK}/health >/dev/null" 2>/dev/null; then
      log "Контейнер запущен и healthcheck отвечает"
      break
    fi
  fi

  if [ "$i" -eq 30 ]; then
    echo ""
    docker logs support-chat --tail=40 2>&1 || true
    err "Приложение не прошло проверку готовности"
  fi
  sleep 1
done

echo ""
log "Обновление завершено!"
echo ""
echo "  Последние логи:"
docker logs support-chat --tail=12 2>&1 || true
echo ""
echo -e "  Мониторинг: ${BLUE}docker logs support-chat -f${NC}"
echo -e "  Проверка токена: ${BLUE}docker exec support-chat sh -lc 'test -n \"\$ADMIN_TOKEN\" && echo ADMIN_TOKEN_OK'${NC}"
echo ""
