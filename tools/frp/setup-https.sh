#!/usr/bin/env bash
# Standalone FRP panel deployment using the host's existing Caddy service.
set -Eeuo pipefail
fail() { echo "Ошибка: $*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || fail "Запустите через sudo bash tools/frp/setup-https.sh"
tool_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$tool_dir"
for command in docker caddy curl openssl systemctl; do
  command -v "$command" >/dev/null || fail "Не найден $command. Нужны Docker Compose и установленный Caddy (как для чата)."
done
docker compose version >/dev/null
panel_domain="${1:-router.kv9.ru}"
[[ ${#panel_domain} -le 253 && "$panel_domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ && "$panel_domain" == *.* ]] || fail "Укажите домен без https://, пути и порта"
if [[ ! -f .env ]]; then
  umask 077
  cp .env.example .env
  panel_secret="$(openssl rand -hex 32)"
  sed -i "s/^FRP_ADMIN_TOKEN=.*/FRP_ADMIN_TOKEN=$panel_secret/" .env
fi
# Read dotenv values without executing shell code from the configuration.
env_value() {
  local result
  result="$(sed -n "s/^$1=//p" .env | tail -n 1 | tr -d '\r')"
  result="${result#\"}"; result="${result%\"}"
  result="${result#\'}"; result="${result%\'}"
  printf '%s' "$result"
}
panel_port="$(env_value FRP_PANEL_PORT)"; panel_port="${panel_port:-7400}"
panel_host="$(env_value FRP_PANEL_HOST)"; panel_host="${panel_host:-127.0.0.1}"
panel_token="$(env_value FRP_ADMIN_TOKEN)"
[[ ${#panel_token} -ge 24 && "$panel_token" != replace-with-* ]] || fail "Задайте FRP_ADMIN_TOKEN в tools/frp/.env (не менее 24 символов)"
[[ "$panel_port" =~ ^[0-9]{1,5}$ ]] && ((10#$panel_port >= 1024 && 10#$panel_port <= 65535)) || fail "Некорректный FRP_PANEL_PORT"
[[ "$panel_host" == 127.0.0.1 || "$panel_host" == 0.0.0.0 ]] || fail "Для этого установщика задайте FRP_PANEL_HOST=127.0.0.1; другие интерфейсы требуют собственного reverse_proxy"
panel_port="$((10#$panel_port))"
caddy_file=/etc/caddy/Caddyfile
site_file=/etc/caddy/frp-sites/panel.caddy
[[ -f "$caddy_file" ]] || fail "Не найден $caddy_file"
echo "Запуск независимой FRP-панели…"
docker compose up -d --build
curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 2 --max-time 5 "http://127.0.0.1:$panel_port/health" >/dev/null || fail "Панель не запустилась. Проверьте docker compose logs"
backup_dir="$(mktemp -d)"
cp -p "$caddy_file" "$backup_dir/Caddyfile"
had_site=false
if [[ -f "$site_file" ]]; then cp -p "$site_file" "$backup_dir/panel.caddy"; had_site=true; fi
committed=false
cleanup() {
  if [[ "$committed" != true ]]; then
    cp -p "$backup_dir/Caddyfile" "$caddy_file"
    if [[ "$had_site" == true ]]; then cp -p "$backup_dir/panel.caddy" "$site_file"; else rm -f "$site_file"; fi
    systemctl reload caddy || true
  fi
  rm -rf "$backup_dir"
}
trap cleanup EXIT
mkdir -p /etc/caddy/frp-sites
chmod 755 /etc/caddy/frp-sites
cat > "$site_file" <<CADDY
$panel_domain {
    bind 0.0.0.0
    reverse_proxy 127.0.0.1:$panel_port
    encode zstd gzip
}
CADDY
chmod 644 "$site_file"
if ! grep -Eq '^import /etc/caddy/frp-sites/\*\.caddy[[:space:]]*$' "$caddy_file"; then
  printf '\nimport /etc/caddy/frp-sites/*.caddy\n' >> "$caddy_file"
fi
caddy validate --config "$caddy_file" --adapter caddyfile
systemctl reload caddy
committed=true
echo "Ожидание HTTPS-сертификата для $panel_domain…"
if ! curl --fail --silent --show-error --retry 12 --retry-all-errors --retry-delay 5 --max-time 10 "https://$panel_domain/health" > /dev/null; then
  echo "HTTPS ещё не заработал. Конфигурация сохранена; Caddy продолжит получение сертификата." >&2
  echo "Проверьте DNS A/AAAA этого домена, доступность 80/443 и journalctl -u caddy --no-pager -n 50" >&2
  exit 1
fi
echo "Панель доступна: https://$panel_domain/"
echo "Ключ входа FRP_ADMIN_TOKEN хранится в $tool_dir/.env"
root_dir="$(cd "$tool_dir/../.." && pwd)"
if [[ -f "$root_dir/.env" ]]; then
  # Preserve dotenv quoting, never source the file or print credentials.
  root_env_tmp="$(mktemp "$root_dir/.env.frp.XXXXXX")"
  chmod 600 "$root_env_tmp"
  awk '!/^FRP_SERVICE_(URL|TOKEN)=/' "$root_dir/.env" > "$root_env_tmp"
  printf '\nFRP_SERVICE_URL=http://127.0.0.1:%s\n' "$panel_port" >> "$root_env_tmp"
  sed -n 's/^FRP_ADMIN_TOKEN=/FRP_SERVICE_TOKEN=/p' .env | tail -n 1 >> "$root_env_tmp"
  mv "$root_env_tmp" "$root_dir/.env"
  docker compose --project-directory "$root_dir" -f "$root_dir/docker-compose.yml" up -d --build support-chat
  echo "Общий раздел «Устройства» подключён: вход через админку чата или Telegram Mini App."
fi
