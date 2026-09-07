#!/bin/sh
set -eu
# HTTP administration only; torrent peer traffic is not filtered here.
port="${LAMPAC_TORR_PORT:-9085}"
case "$port" in ''|*[!0-9]*) exit 1 ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ]
for tool in /usr/sbin/iptables /usr/sbin/ip6tables; do
    "$tool" -C INPUT ! -i lo -p tcp --dport "$port" -j REJECT 2>/dev/null ||
        "$tool" -I INPUT ! -i lo -p tcp --dport "$port" -j REJECT
done
