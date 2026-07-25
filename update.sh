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

# Проверка обязательных переменных
set -a
source .env
set +a

[ -n "${TELEGRAM_BOT_TOKEN:-}" ] || err "В .env не задан TELEGRAM_BOT_TOKEN"
[ -n "${TELEGRAM_GROUP_ID:-}" ] || err "В .env не задан TELEGRAM_GROUP_ID"
[ -n "${ADMIN_TOKEN:-}" ] || err "В .env не задан ADMIN_TOKEN (админ-панель не будет доступна)"
[ -n "${TELEGRAM_ADMIN_IDS:-}" ] || warn "TELEGRAM_ADMIN_IDS не задан — Telegram Mini App не пустит админа без ручного ADMIN_TOKEN"

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
