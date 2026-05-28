#!/usr/bin/env bash
# Foreground starter. Use ecosystem.config.js + PM2 for unattended hosting.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f .env ]]; then
  echo "❌ .env is missing. Run: bash install.sh" >&2
  exit 1
fi

mkdir -p data
exec node src/index.js
