#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

git pull --ff-only
docker compose pull
docker compose up -d
docker image prune -f
