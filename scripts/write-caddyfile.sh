#!/bin/bash

write_caddyfile() {
    local domain="$1"
    local port="${2:-3001}"
    local output="${3:-/etc/caddy/Caddyfile}"

    [[ "$domain" =~ ^[A-Za-z0-9.-]+$ ]] || {
        echo "Некорректный домен для Caddy: $domain" >&2
        return 1
    }
    [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1 && port <= 65535)) || {
        echo "Некорректный порт приложения: $port" >&2
        return 1
    }

    cat > "$output" <<CADDY
${domain} {
    bind 0.0.0.0

    reverse_proxy 127.0.0.1:${port} {
        header_up X-Real-IP {remote_host}
    }

    encode zstd gzip

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
        output stdout
    }
}
CADDY
}
