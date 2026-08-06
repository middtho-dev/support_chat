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
source "$SCRIPT_DIR/scripts/write-caddyfile.sh"

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║        Support Chat — Обновление         ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

[ -f ".env" ] || err ".env не найден. Сначала запустите setup.sh"
command -v docker >/dev/null 2>&1 || err "Docker не установлен"
docker compose version >/dev/null 2>&1 || err "Docker Compose недоступен"

# Build first, then replace the running container. This keeps the current
# service available if the image cannot be assembled or pulled.
if [ -d .git ]; then
  info "Получаю актуальную версию из Git..."
  git pull --ff-only
  APP_VERSION="$(git rev-parse --short HEAD)"
else
  APP_VERSION="manual-$(date -u +%Y%m%d%H%M%S)"
fi
export APP_VERSION
log "Будет запущена версия ${APP_VERSION}"

# Проверка обязательных переменных
set -a
source .env
set +a

[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || err "В .env не задан TELEGRAM_BOT_TOKEN"
[ -n "${ADMIN_TOKEN:-}" ] || err "В .env не задан ADMIN_TOKEN (админ-панель не будет доступна)"
if [ "${TELEGRAM_MODE:-private}" = "private" ]; then
  [ -n "${TELEGRAM_ADMIN_IDS:-}" ] || err "В private-режиме обязателен TELEGRAM_ADMIN_IDS"
else
  [ -n "${TELEGRAM_GROUP_ID:-}" ] || err "В legacy-режиме обязателен TELEGRAM_GROUP_ID"
fi

# Не патчим старый Caddyfile регулярками: формат мог измениться.
# Полностью пересоздаём конфиг из PUBLIC_URL, но сохраняем backup до успешной проверки.
if command -v caddy >/dev/null 2>&1 && [ -n "${PUBLIC_URL:-}" ]; then
  info "Пересоздаю конфигурацию Caddy..."
  CADDY_DOMAIN="${PUBLIC_URL#*://}"
  CADDY_DOMAIN="${CADDY_DOMAIN%%/*}"
  CADDY_BACKUP="/etc/caddy/Caddyfile.update-backup"
  [ ! -f /etc/caddy/Caddyfile ] || cp -a /etc/caddy/Caddyfile "$CADDY_BACKUP"
  if ! write_caddyfile "$CADDY_DOMAIN" "${PORT:-3001}" /etc/caddy/Caddyfile \
      || ! caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null \
      || ! caddy validate --config /etc/caddy/Caddyfile >/dev/null; then
    [ ! -f "$CADDY_BACKUP" ] || cp -a "$CADDY_BACKUP" /etc/caddy/Caddyfile
    err "Новый Caddyfile не прошёл проверку; прежний конфиг восстановлен."
  fi
  if ! systemctl restart caddy || ! systemctl is-active --quiet caddy; then
    journalctl -u caddy --no-pager -n 30 || true
    err "Caddy не запустился после обновления; причина показана выше."
  fi
  rm -f "$CADDY_BACKUP"
  log "Конфигурация Caddy пересоздана, Caddy запущен"
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
if [ "${TELEGRAM_MODE:-private}" = "private" ]; then
  warn "Проверьте Threaded Mode в @BotFather и выполните /start от каждого ID из TELEGRAM_ADMIN_IDS"
fi

PREVIOUS_CONTAINER_ID="$(docker compose ps -q support-chat 2>/dev/null || true)"

info "Пересобираю свежий образ, не останавливая работающий контейнер..."
docker compose build --pull --no-cache support-chat

info "Принудительно пересоздаю контейнер приложения..."
docker compose up -d --force-recreate --remove-orphans support-chat
CURRENT_CONTAINER_ID="$(docker compose ps -q support-chat 2>/dev/null || true)"
[ -n "$CURRENT_CONTAINER_ID" ] || err "Docker Compose не создал контейнер support-chat"
if [ -n "$PREVIOUS_CONTAINER_ID" ] && [ "$PREVIOUS_CONTAINER_ID" = "$CURRENT_CONTAINER_ID" ]; then
  err "Контейнер не был пересоздан"
fi

info "Жду готовность приложения..."
PORT_TO_CHECK="${PORT:-3001}"
for i in {1..30}; do
  if docker ps --filter "name=^/support-chat$" --filter "status=running" --format '{{.Names}}' | grep -qx "support-chat"; then
    HEALTH="$(docker exec support-chat sh -lc "wget -qO- http://127.0.0.1:${PORT_TO_CHECK}/health" 2>/dev/null || true)"
    if printf '%s' "$HEALTH" | grep -q '"ok":true' \
      && printf '%s' "$HEALTH" | grep -q "\"version\":\"${APP_VERSION}\""; then
      log "Контейнер пересоздан и healthcheck подтвердил версию ${APP_VERSION}"
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

info "Удаляю только висячие старые образы (данные и named volumes не затрагиваются)..."
docker image prune -f >/dev/null
log "Старые висячие образы очищены"

echo ""
log "Обновление завершено!"
echo ""
echo "  Последние логи:"
docker logs support-chat --tail=12 2>&1 || true
echo ""
echo -e "  Мониторинг: ${BLUE}docker logs support-chat -f${NC}"
echo -e "  Проверка токена: ${BLUE}docker exec support-chat sh -lc 'test -n \"\$ADMIN_TOKEN\" && echo ADMIN_TOKEN_OK'${NC}"
echo ""
