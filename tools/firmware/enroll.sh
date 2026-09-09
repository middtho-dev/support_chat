#!/bin/sh
set -eu
umask 077
[ ! -f /etc/kv9-frpc-ready ] || exit 0
. /etc/kv9-frpc-enrollment
mac=$(cat /sys/class/net/eth0/address)
printf '%s\n' "$mac" | grep -Eq '^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$' || exit 1
[ "$mac" != '00:00:00:00:00:00' ] || exit 1
fingerprint=$(printf '%s\n' "$mac" | sha256sum | cut -d' ' -f1)
[ ${#fingerprint} = 64 ] || exit 1
while [ ! -f /etc/kv9-frpc-ready ]; do
    reply=$(mktemp)
    script=$(mktemp)
    if curl -fsS --connect-timeout 15 --max-time 45 -H "Authorization: Bearer $token" -H 'Content-Type: application/json' --data "{\"operation\":\"claim\",\"fingerprint\":\"$fingerprint\"}" "$endpoint" >"$reply" && jq -er '.script' "$reply" | base64 -d >"$script" && KV9_FRPC_PREINSTALLED=1 KV9_FRPC_FRESH=1 sh "$script" >/tmp/kv9-frpc-enroll.log 2>&1; then
        touch /etc/kv9-frpc-ready
        rm -f /etc/kv9-frpc-enrollment
        /etc/init.d/kv9-frpc-enroll disable
        logger -t kv9-frpc 'FRPC configured; enrollment complete'
    else
        logger -t kv9-frpc 'Enrollment pending; verify WAN, clock and FRP server'
    fi
    rm -f "$reply" "$script"
    [ -f /etc/kv9-frpc-ready ] || sleep 60
done
