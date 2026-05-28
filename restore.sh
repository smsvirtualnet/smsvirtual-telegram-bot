#!/usr/bin/env bash
# Restore the SQLite database from a backup file.
# Usage:
#   bash restore.sh data/backups/bot-20260101T120000Z.sqlite[.gz]
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

if [[ $# -ne 1 ]]; then
  echo "Usage: bash restore.sh <backup-file>" >&2
  exit 1
fi

SRC="$1"
DB="${DATABASE_FILE:-./data/bot.sqlite}"

if [[ ! -f "$SRC" ]]; then
  echo "❌ Backup file not found: $SRC" >&2
  exit 1
fi

echo "⚠️  This will overwrite ${DB}."
echo "   Stop the bot first (pm2 stop smsvirtual-telegram-bot)."
read -r -p "Continue? [y/N] " ans
case "$ans" in
  y|Y|yes|YES) ;;
  *) echo "Aborted."; exit 0 ;;
esac

mkdir -p "$(dirname "$DB")"
TMP="$(mktemp)"

case "$SRC" in
  *.gz)
    gunzip -c "$SRC" > "$TMP"
    ;;
  *)
    cp -p "$SRC" "$TMP"
    ;;
esac

# Overwrite (keep existing -wal/-shm so SQLite recovers cleanly).
mv "$TMP" "$DB"
chmod 600 "$DB"
echo "✅ Restore complete: $DB"
echo "   Restart the bot: pm2 restart smsvirtual-telegram-bot   (or)   bash start.sh"
