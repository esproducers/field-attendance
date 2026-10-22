#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Install and start Docker Desktop'; exit 1; }
docker info >/dev/null || { echo 'Docker engine not running'; exit 1; }
if [ ! -f .env ]; then cp .env.example .env; echo 'Edit .env passwords and run again'; exit 1; fi
if grep -q CHANGE_ME .env; then echo 'Replace all CHANGE_ME placeholders in .env'; exit 1; fi
mkdir -p storage/uploads storage/backups
docker compose config --quiet
docker compose up -d --build
docker compose ps
echo 'Open http://localhost:8080'
