#!/bin/sh
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'ERROR: SSH user must be root.'; exit 1; }
[ -f /etc/openwrt_release ] && command -v uci >/dev/null || { echo 'ERROR: This is not OpenWrt with UCI.'; exit 1; }
mkdir /tmp/kv9-frpc-install.lock 2>/dev/null || { echo 'ERROR: Another installation is running.'; exit 1; }
backup=''
changed=0
was_enabled=0
was_running=0
cleanup() {
    code=$?
    trap - EXIT
    if [ "$code" != 0 ] && [ "$changed" = 1 ] && [ -n "$backup" ]; then
        echo 'Installation failed. Restoring previous FRPC configuration.'
        uci -q revert frpc || true
        cp "$backup" /etc/config/frpc
        if [ "$was_enabled" = 1 ]; then /etc/init.d/frpc enable; else /etc/init.d/frpc disable; fi
        if [ "$was_running" = 1 ]; then /etc/init.d/frpc restart || true; else /etc/init.d/frpc stop || true; fi
    fi
    rmdir /tmp/kv9-frpc-install.lock
    exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fresh=1
[ ! -f /etc/config/frpc ] || fresh=0
if [ "$fresh" = 0 ]; then
    backup="/etc/config/frpc.kv9-backup-$(date +%s)-$$"
    cp /etc/config/frpc "$backup"
    /etc/init.d/frpc enabled >/dev/null 2>&1 && was_enabled=1 || true
    /etc/init.d/frpc running >/dev/null 2>&1 && was_running=1 || true
fi
echo '[1/3] Installing frpc and luci-app-frpc from configured OpenWrt repositories...'
if command -v apk >/dev/null 2>&1; then
    apk update
    apk add frpc luci-app-frpc
elif command -v opkg >/dev/null 2>&1; then
    opkg update
    opkg install frpc luci-app-frpc
else
    echo 'ERROR: Neither apk nor opkg is available.'; exit 1
fi
[ -x /etc/init.d/frpc ] && [ -f /etc/config/frpc ] || { echo 'ERROR: OpenWrt FRPC service/config not found.'; exit 1; }
if [ -z "$backup" ]; then
    backup="/etc/config/frpc.kv9-backup-$(date +%s)-$$"
    cp /etc/config/frpc "$backup"
fi
server=@@SERVER@@
server_port=@@SERVER_PORT@@
token=@@TOKEN@@
port=@@PORT@@
section="kv9_luci_$port"
# Preserve existing tunnels, but refuse to silently move them to another server.
old_server=$(uci -q get frpc.common.server_addr || true)
old_port=$(uci -q get frpc.common.server_port || true)
if [ "$fresh" = 0 ] && { [ "$old_server" != "$server" ] || [ "$old_port" != "$server_port" ]; }; then
    echo 'ERROR: Existing FRPC uses another server. Review its settings in LuCI first.'; exit 1
fi
echo '[2/3] Configuring the LuCI TCP tunnel...'
changed=1
if [ "$fresh" = 1 ]; then uci -q delete frpc.ssh || true; fi
uci set frpc.common=conf
uci set "frpc.common.server_addr=$server"
uci set "frpc.common.server_port=$server_port"
uci set frpc.common.authentication_method=token
uci set "frpc.common.token=$token"
uci set frpc.common.tls_enable=true
uci set frpc.common.login_fail_exit=false
uci -q delete frpc.common.token_source_type || true
uci -q delete frpc.common.token_source_file_path || true
uci -q delete frpc.common.token_source_exec_command || true
uci -q delete "frpc.$section" || true
uci set "frpc.$section=conf"
uci set "frpc.$section.name=$section"
uci set "frpc.$section.type=tcp"
uci set "frpc.$section.local_ip=127.0.0.1"
uci set "frpc.$section.local_port=80"
uci set "frpc.$section.remote_port=$port"
uci set "frpc.$section.enabled=true"
uci commit frpc
echo '[3/3] Enabling and starting FRPC...'
/etc/init.d/frpc enable
/etc/init.d/frpc restart
sleep 3
/etc/init.d/frpc running >/dev/null 2>&1 || { echo 'ERROR: FRPC did not stay running.'; exit 1; }
echo "FRPC is running. Backup: $backup"
echo "Tunnel: $server:$port -> 127.0.0.1:80"
echo 'LuCI: Services > FRP Client. Confirm online status in the KV9 panel.'
