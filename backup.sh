#!/usr/bin/env bash
# Backup the SQLite database to a timestamped tarball under data/backups/.
# Uses `sqlite3 .backup` so the copy is safe to take while the bot is running.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

DB="${DATABASE_FILE:-./data/bot.sqlite}"
DEST_DIR="./data/backups"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${DEST_DIR}/bot-${TS}.sqlite"

if [[ ! -f "$DB" ]]; then
  echo "❌ Database file not found: $DB" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
chmod 700 "$DEST_DIR"

if command -v sqlite3 >/dev/null 2>&1; then
  echo "▶ sqlite3 .backup → $DEST"
  sqlite3 "$DB" ".backup '$DEST'"
else
  echo "▶ sqlite3 not found, falling back to file copy"
  cp -p "$DB" "$DEST"
fi

if command -v gzip >/dev/null 2>&1; then
  gzip -9 "$DEST"
  DEST="${DEST}.gz"
fi

chmod 600 "$DEST"
echo "✅ Backup written: $DEST"
