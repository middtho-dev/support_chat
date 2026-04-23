#!/bin/bash
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[→]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

clear
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║        Support Chat — Установка          ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

[ "$EUID" -ne 0 ] && err "Нужен root: sudo bash setup.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Ввод данных ──
read -p "$(echo -e ${BLUE})Домен (например helpo.su): $(echo -e ${NC})" DOMAIN
[[ -z "$DOMAIN" ]] && err "Домен не указан"

read -p "$(echo -e ${BLUE})Telegram Bot Token: $(echo -e ${NC})" TG_TOKEN
[[ -z "$TG_TOKEN" ]] && err "Токен не указан"

read -p "$(echo -e ${BLUE})Telegram Group ID (-1001234567890): $(echo -e ${NC})" TG_GROUP
[[ -z "$TG_GROUP" ]] && err "Group ID не указан"

SERVER_IP=$(curl -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')

echo ""
echo -e "  Домен:     ${GREEN}$DOMAIN${NC}"
echo -e "  IP:        ${GREEN}$SERVER_IP${NC}"
echo -e "  TG Token:  ${GREEN}${TG_TOKEN:0:12}...${NC}"
echo -e "  TG Group:  ${GREEN}$TG_GROUP${NC}"
echo ""
echo -e "${YELLOW}Убедитесь что DNS A-запись $DOMAIN → $SERVER_IP настроена!${NC}"
echo -e "${YELLOW}Порты 80 и 443 должны быть свободны.${NC}"
echo ""
read -p "Продолжить? (y/n): " CONFIRM
[[ "$CONFIRM" != "y" ]] && echo "Отменено." && exit 0

# ── 1. Docker ──
echo ""
info "1/5 Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh -s -- -y
  log "Docker установлен"
else
  log "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

# ── 2. Caddy ──
info "2/5 Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https -qq 2>/dev/null || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq && apt-get install -y caddy -qq
  log "Caddy установлен"
else
  log "Caddy: $(caddy version | head -1)"
fi

# ── 3. .env ──
info "3/5 Конфигурация..."
cat > "$SCRIPT_DIR/.env" << ENV
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_GROUP_ID=${TG_GROUP}
PORT=3001
ENV
log ".env создан"

# ── 4. Caddyfile ──
info "4/5 Настройка Caddy (HTTPS)..."
mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy 2>/dev/null || true

cat > /etc/caddy/Caddyfile << CADDY
${DOMAIN} {
    reverse_proxy localhost:3001 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up Host {host}
    }

    encode zstd gzip

    @static path /css/* /js/* /uploads/*
    header @static Cache-Control "public, max-age=31536000, immutable"

    header {
        -Server
        X-Content-Type-Options nosniff
        X-Frame-Options SAMEORIGIN
    }

    log {
        output file /var/log/caddy/access.log {
            roll_size 10mb
            roll_keep 5
        }
    }
}
CADDY

systemctl enable caddy
systemctl restart caddy
sleep 3

if systemctl is-active --quiet caddy; then
  log "Caddy запущен — HTTPS будет готов через ~10 сек после первого обращения"
else
  echo ""
  journalctl -u caddy --no-pager -n 15
  err "Caddy не запустился. Проверьте что порты 80 и 443 свободны."
fi

# ── 5. Приложение ──
info "5/5 Сборка и запуск приложения..."
cd "$SCRIPT_DIR"
docker compose down 2>/dev/null || true
docker compose build --no-cache
docker compose up -d
sleep 3

if docker ps | grep -q "support-chat"; then
  log "Контейнер запущен"
else
  docker logs support-chat --tail=20 2>&1 || true
  err "Контейнер не запустился"
fi

# ── Firewall ──
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp  >/dev/null 2>&1 || true
  ufw allow 80/tcp  >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
  log "Firewall: открыты 22, 80, 443"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Установка завершена!             ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  🌐  ${GREEN}https://${DOMAIN}${NC}"
echo -e "  🔒  Сертификат Let's Encrypt (авто)"
echo ""
echo "  Команды:"
echo -e "  ${BLUE}docker logs support-chat -f${NC}    # логи"
echo -e "  ${BLUE}docker compose restart${NC}         # перезапуск"
echo -e "  ${BLUE}journalctl -u caddy -f${NC}         # логи Caddy"
echo ""
