#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p storage/backups
out="storage/backups/attendance-$(date +%Y%m%d-%H%M%S).sql"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$out"
echo "Backup saved to $out. Back up storage/uploads separately."
