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

APT_LOCK_TIMEOUT=600
apt_run() {
    # unattended-upgrades часто запущен сразу после старта VPS.
    # Не удаляем lock-файлы: это может повредить dpkg. APT сам дождётся освобождения.
    if ! DEBIAN_FRONTEND=noninteractive apt-get \
        -o "DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT}" \
        "$@"; then
        err "APT не смог выполнить команду за ${APT_LOCK_TIMEOUT} с. Дождитесь завершения unattended-upgrades и повторите setup.sh."
    fi
}

clear
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════╗"
echo "║        Support Chat — Установка          ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

[ "$EUID" -ne 0 ] && err "Нужен root: sudo bash setup.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/write-caddyfile.sh"

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

read -p "$(echo -e "${BLUE}")Telegram ID операторов через запятую (например 123456789,987654321): $(echo -e "${NC}")" TG_ADMINS
[[ -z "$TG_ADMINS" ]] && err "Telegram ID операторов не указаны"

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
echo -e "  TG Admins:  ${GREEN}$TG_ADMINS${NC}"
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
    info "Проверяю APT (если идёт unattended-upgrades, жду освобождения до 10 минут)..."
    apt_run update -qq

    apt_run install -y \
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

    apt_run update -qq
    apt_run install -y caddy -qq

    log "Caddy установлен"
else
    log "Caddy: $(caddy version | head -1)"
fi

# ── 3. .env ──
info "3/5 Конфигурация..."

cat > "$SCRIPT_DIR/.env" <<ENV
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
TELEGRAM_MODE=private
TELEGRAM_ADMIN_IDS=${TG_ADMINS}
ADMIN_TOKEN=${ADMIN_TOKEN}
PUBLIC_URL=https://${DOMAIN}
PORT=3001
ENV

chmod 600 "$SCRIPT_DIR/.env"

log ".env создан"

# ── 4. Caddyfile ──
info "4/5 Настройка Caddy (HTTPS по IPv4)..."

write_caddyfile "$DOMAIN" 3001 /etc/caddy/Caddyfile \
    || err "Не удалось создать Caddyfile"

# Форматируем и проверяем конфигурацию перед перезапуском.
caddy fmt --overwrite /etc/caddy/Caddyfile \
    || err "Не удалось отформатировать Caddyfile"
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
    err "Caddy не запустился. Причина указана в журнале выше; также проверьте порты 80 и 443."
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
echo -e "  🤖  Включите Threaded Mode у бота через @BotFather"
echo -e "  👤  Каждый оператор должен открыть бота и нажать /start"
echo ""
echo "  Проверка портов:"
echo -e "  ${BLUE}ss -lntp | grep -E ':80|:443|:3001'${NC}"
echo ""
echo "  Команды:"
echo -e "  ${BLUE}docker logs support-chat -f${NC}    # логи приложения"
echo -e "  ${BLUE}docker compose restart${NC}         # перезапуск приложения"
echo -e "  ${BLUE}journalctl -u caddy -f${NC}         # логи Caddy"
echo ""
