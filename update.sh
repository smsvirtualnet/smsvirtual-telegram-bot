#!/usr/bin/env bash
# Pull the latest code (if this is a git checkout), reinstall dependencies,
# and apply any new migrations. Safe to run on a live install — the bot keeps
# running until you restart it (use `pm2 restart` or re-launch start.sh).
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

echo "▶ Updating SMS Virtual Telegram Bot …"

if [[ -d .git ]]; then
  echo "▶ git pull"
  git pull --ff-only
fi

if [[ -f package-lock.json ]]; then
  npm ci --omit=dev || npm install --omit=dev
else
  npm install --omit=dev
fi

echo "▶ Running migrations"
npm run migrate

echo "✅ Update complete. Restart the bot to pick up changes."
echo "   PM2 users:        pm2 restart smsvirtual-telegram-bot"
echo "   Foreground users: stop start.sh and re-run it"
