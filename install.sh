#!/usr/bin/env bash
# =============================================================================
#  SMS Virtual Telegram Bot — installer
# =============================================================================
#  Sets up the bot on Termux (Android) or a Debian/Ubuntu VPS.
#
#  Steps performed:
#    1. Detect environment (Termux vs Linux).
#    2. Make sure Node.js >= 20, build tools, and SQLite are present.
#    3. Run `npm ci` (preferred) or `npm install`.
#    4. Bootstrap `.env` from `.env.example` if missing, lock to 0600.
#    5. Apply database migrations.
#    6. Print next-step guidance.
#
#  Usage:
#     bash install.sh
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }

is_termux() {
  [[ -n "${PREFIX:-}" && "${PREFIX:-}" == *"com.termux"* ]] || command -v termux-info >/dev/null 2>&1
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    red "Missing command: $1"
    return 1
  fi
}

check_node_version() {
  local v
  v="$(node -v 2>/dev/null | sed 's/^v//')" || return 1
  local major="${v%%.*}"
  if (( major < 20 )); then
    red "Node.js >= 20 required, found v$v"
    return 1
  fi
  green "Node.js v$v ✓"
}

bold "▶ SMS Virtual Telegram Bot — installer"

if is_termux; then
  yellow "Detected: Termux"
  pkg update -y >/dev/null
  pkg install -y nodejs-lts python make clang sqlite >/dev/null
else
  yellow "Detected: Linux (Debian/Ubuntu assumed)"
  if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; else SUDO=""; fi
  if ! command -v node >/dev/null 2>&1 || ! check_node_version >/dev/null 2>&1; then
    yellow "Installing Node.js 20 via NodeSource …"
    $SUDO apt-get update -y
    $SUDO apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
  fi
  $SUDO apt-get install -y build-essential python3 sqlite3 >/dev/null || true
fi

require_cmd node
require_cmd npm
check_node_version

bold "▶ Installing npm dependencies"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev || npm install --omit=dev
else
  npm install --omit=dev
fi

if [[ ! -f .env ]]; then
  bold "▶ Creating .env from template"
  cp .env.example .env
  chmod 600 .env
  yellow "✏️  Edit .env now: TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_ID, SMSVIRTUAL_API_KEY"
else
  green "✓ .env already exists (left untouched)"
fi

bold "▶ Applying database migrations"
mkdir -p data
chmod 700 data
npm run migrate

bold "▶ Done"
cat <<EOF

Next steps:

  1. Edit .env and fill in TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_ID.
     For personal mode, also set SMSVIRTUAL_API_KEY.

  2. Start the bot:
       Foreground:        bash start.sh
       PM2 (recommended): npm i -g pm2 && pm2 start ecosystem.config.js

  3. Open Telegram, message your bot, and run /setup if you have not set
     SMSVIRTUAL_API_KEY in .env.

  Logs:           data/bot.log    (if LOG_TO_FILE=true)
  Database:       data/bot.sqlite
  PM2 logs:       data/pm2.out.log, data/pm2.err.log

EOF
