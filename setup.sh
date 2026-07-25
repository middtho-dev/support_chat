#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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

# Не отключаем IPv6 глобально: это может оборвать SSH-сессию.
# Вместо этого привязываем все сервисы к IPv4 и принудительно используем IPv4 для загрузок.
info "Настройка установки через IPv4..."

mkdir -p /etc/apt/apt.conf.d

cat > /etc/apt/apt.conf.d/99force-ipv4 <<'EOF'
Acquire::ForceIPv4 "true";
EOF

log "APT настроен на IPv4"

# ── Ввод данных ──
read -p "$(echo -e "${BLUE}")Домен (например helpo.su): $(echo -e "${NC}")" DOMAIN
[[ -z "$DOMAIN" ]] && err "Домен не указан"

read -p "$(echo -e "${BLUE}")Telegram Bot Token: $(echo -e "${NC}")" TG_TOKEN
[[ -z "$TG_TOKEN" ]] && err "Токен не указан"

read -p "$(echo -e "${BLUE}")Telegram Group ID (-1001234567890): $(echo -e "${NC}")" TG_GROUP
[[ -z "$TG_GROUP" ]] && err "Group ID не указан"

read -p "$(echo -e "${BLUE}")Admin Token для /admin: $(echo -e "${NC}")" ADMIN_TOKEN
[[ -z "$ADMIN_TOKEN" ]] && err "Admin Token не указан"

is_ipv4() {
    local ip="$1" octet
    [[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
    IFS='.' read -r -a octets <<< "$ip"
    for octet in "${octets[@]}"; do
        ((10#$octet <= 255)) || return 1
    done
}

# Получаем именно публичный IPv4. hostname -I здесь не подходит:
# за NAT он может вернуть частный адрес, который нельзя указывать в DNS.
SERVER_IP=""
for IP_SERVICE in https://api.ipify.org https://ipv4.icanhazip.com; do
    SERVER_IP="$(curl -4 -fsS --max-time 10 "$IP_SERVICE" 2>/dev/null | tr -d '[:space:]' || true)"
    is_ipv4 "$SERVER_IP" && break
    SERVER_IP=""
done

[[ -n "$SERVER_IP" ]] \
    || err "Не удалось определить публичный IPv4. Проверьте, что у VPS есть выход в интернет по IPv4."

DNS_IPV4="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | paste -sd, - || true)"

echo ""
echo -e "  Домен:      ${GREEN}$DOMAIN${NC}"
echo -e "  IPv4:       ${GREEN}$SERVER_IP${NC}"
echo -e "  TG Token:   ${GREEN}${TG_TOKEN:0:12}...${NC}"
echo -e "  TG Group:   ${GREEN}$TG_GROUP${NC}"
echo -e "  AdminToken: ${GREEN}${ADMIN_TOKEN:0:6}...${NC}"
echo -e "  DNS A:      ${GREEN}${DNS_IPV4:-не найдена}${NC}"
echo ""
if [[ ",${DNS_IPV4}," == *",${SERVER_IP},"* ]]; then
    log "DNS A-запись $DOMAIN уже указывает на $SERVER_IP"
else
    echo -e "${RED}[!] DNS A-запись $DOMAIN пока не указывает на $SERVER_IP.${NC}"
    echo -e "${YELLOW}    Исправьте A-запись перед продолжением, иначе HTTPS-сертификат не будет выдан.${NC}"
fi
echo -e "${YELLOW}AAAA-запись для домена использовать не нужно.${NC}"
echo -e "${YELLOW}Порты 80 и 443 должны быть свободны.${NC}"
echo ""

read -p "Продолжить? (y/n): " CONFIRM
[[ "$CONFIRM" != "y" ]] && echo "Отменено." && exit 0

# ── 1. Docker ──
echo ""
info "1/5 Docker..."

if ! command -v docker &>/dev/null; then
    curl -4 -fsSL https://get.docker.com | sh -s -- -y
    log "Docker установлен"
else
    log "Docker: $(docker --version | cut -d' ' -f3 | tr -d ',')"
fi

systemctl enable docker >/dev/null 2>&1 || true
systemctl start docker

# ── 2. Caddy ──
info "2/5 Caddy..."

if ! command -v caddy &>/dev/null; then
    apt-get update -qq

    apt-get install -y \
        debian-keyring \
        debian-archive-keyring \
        apt-transport-https \
        curl \
        gnupg \
        -qq

    rm -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg

    curl -4 -1sLf \
        'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor \
        -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg

    curl -4 -1sLf \
        'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null

    apt-get update -qq
    apt-get install -y caddy -qq

    log "Caddy установлен"
else
    log "Caddy: $(caddy version | head -1)"
fi

# ── 3. .env ──
info "3/5 Конфигурация..."

cat > "$SCRIPT_DIR/.env" <<ENV
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_GROUP_ID=${TG_GROUP}
TELEGRAM_ADMIN_IDS=
ADMIN_TOKEN=${ADMIN_TOKEN}
PUBLIC_URL=https://${DOMAIN}
PORT=3001
ENV

chmod 600 "$SCRIPT_DIR/.env"

log ".env создан"

# ── 4. Caddyfile ──
info "4/5 Настройка Caddy (HTTPS по IPv4)..."

mkdir -p /var/log/caddy
chown -R caddy:caddy /var/log/caddy 2>/dev/null || true

cat > /etc/caddy/Caddyfile <<CADDY
${DOMAIN} {
    bind 0.0.0.0

    reverse_proxy 127.0.0.1:3001 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up Host {host}
    }

    encode zstd gzip

    # JS и HTML не имеют hash в имени: их нельзя кэшировать навсегда,
    # иначе после update.sh на устройствах остаётся старый интерфейс.
    @fresh path / /index.html /admin /admin.html /miniapp /tg-admin /js/* /sw.js /manifest.json
    header @fresh Cache-Control "no-cache, must-revalidate"

    @static path /css/* /logo.png
    header @static Cache-Control "public, max-age=86400"

    @uploads path /uploads/*
    header @uploads Cache-Control "public, max-age=604800"

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

# Проверяем конфигурацию перед перезапуском
caddy validate --config /etc/caddy/Caddyfile \
    || err "Ошибка в конфигурации Caddy"

systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

sleep 3

if systemctl is-active --quiet caddy; then
    log "Caddy запущен по IPv4"
else
    echo ""
    journalctl -u caddy --no-pager -n 30
    err "Caddy не запустился. Проверьте порты 80 и 443."
fi

# ── 5. Приложение ──
info "5/5 Сборка и запуск приложения..."

cd "$SCRIPT_DIR"

docker compose down --remove-orphans 2>/dev/null || true
docker compose build --no-cache
docker compose up -d

sleep 5

if docker ps --format '{{.Names}}' | grep -qx "support-chat"; then
    log "Контейнер support-chat запущен"
else
    docker logs support-chat --tail=50 2>&1 || true
    err "Контейнер support-chat не запустился"
fi

# ── Firewall ──
if command -v ufw &>/dev/null; then
    ufw allow 22/tcp >/dev/null 2>&1 || true
    ufw allow 80/tcp >/dev/null 2>&1 || true
    ufw allow 443/tcp >/dev/null 2>&1 || true
    ufw --force enable >/dev/null 2>&1 || true

    log "Firewall: открыты TCP-порты 22, 80 и 443"
fi

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Установка завершена!            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  🌐  ${GREEN}https://${DOMAIN}${NC}"
echo -e "  🌍  IPv4: ${GREEN}${SERVER_IP}${NC}"
echo -e "  🔒  Сертификат Let's Encrypt автоматически"
echo ""
echo "  Проверка портов:"
echo -e "  ${BLUE}ss -lntp | grep -E ':80|:443|:3001'${NC}"
echo ""
echo "  Команды:"
echo -e "  ${BLUE}docker logs support-chat -f${NC}    # логи приложения"
echo -e "  ${BLUE}docker compose restart${NC}         # перезапуск приложения"
echo -e "  ${BLUE}journalctl -u caddy -f${NC}         # логи Caddy"
echo ""
