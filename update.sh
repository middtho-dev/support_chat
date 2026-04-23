#!/bin/bash
# Быстрое обновление без переустановки Caddy и .env
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "→ Пересобираю контейнер..."
docker compose down
docker compose build --no-cache
docker compose up -d
echo "→ Готово!"
docker logs support-chat --tail=5
