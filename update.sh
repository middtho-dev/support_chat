#!/bin/bash
# Обновление без переустановки Caddy и .env
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║        Support Chat — Обновление         ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

[ -f ".env" ] || err ".env не найден. Сначала запустите setup.sh"

info "Останавливаю контейнер..."
docker compose down

info "Пересобираю образ..."
docker compose build --no-cache

info "Запускаю контейнер..."
docker compose up -d

sleep 3

if docker ps | grep -q "support-chat"; then
  log "Контейнер запущен"
else
  echo ""
  docker logs support-chat --tail=20 2>&1 || true
  err "Контейнер не запустился. Проверьте логи выше."
fi

echo ""
log "Обновление завершено!"
echo ""
echo "  Последние логи:"
docker logs support-chat --tail=8 2>&1 || true
echo ""
echo -e "  Мониторинг: ${BLUE}docker logs support-chat -f${NC}"
echo ""
