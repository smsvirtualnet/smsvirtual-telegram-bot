# SMS Virtual Telegram Bot

A self-hosted Telegram bot for the SMS Virtual public API. Each customer or
reseller runs their own copy on a Termux phone, a Raspberry Pi, or a small
Linux VPS. The bot uses your own Telegram Bot Token and your own SMS Virtual
API key. **No SMS Virtual credentials ever leave your device.**

The bot can:

- Show your account profile and balance
- List countries / operators / services with prices and stock
- Place orders end-to-end (multi-step flow or one-shot smart command)
- Watch for incoming OTPs in the background and push them to Telegram
- Cancel, mark ready, resend, and complete activations
- Request and track deposits
- Save favorites for one-tap re-orders
- Run in personal mode (one owner) or multi mode (allow-listed users with
  per-user API keys)

---

## Table of contents

- [Quick start (TL;DR)](#quick-start-tldr)
- [Prerequisites](#prerequisites)
- [Install — Termux on Android](#install--termux-on-android)
- [Install — Linux VPS (Ubuntu / Debian)](#install--linux-vps-ubuntu--debian)
- [Install — Docker / Docker Compose](#install--docker--docker-compose)
- [Configuration (`.env`)](#configuration-env)
- [Running modes: personal vs multi](#running-modes-personal-vs-multi)
- [Bot commands](#bot-commands)
- [Smart `/order` syntax](#smart-order-syntax)
- [Running the bot](#running-the-bot)
- [Updating](#updating)
- [Backup and restore](#backup-and-restore)
- [Security checklist](#security-checklist)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [License](#license)

---

## Quick start (TL;DR)

```bash
git clone https://github.com/smsvirtualnet/smsvirtual-telegram-bot.git
cd smsvirtual-telegram-bot
bash install.sh
nano .env                    # paste TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_ID, etc.
bash start.sh                # foreground
# or, for unattended hosting:
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

Open Telegram, message your bot, and send `/start`. If you didn't set
`SMSVIRTUAL_API_KEY` in `.env`, run `/setup` and paste your API key.

---

## Prerequisites

You will need:

1. A **Telegram Bot Token**.
   - Open Telegram, talk to [@BotFather](https://t.me/BotFather), send
     `/newbot`, follow the prompts. BotFather gives you a token like
     `1234567890:ABC-DEF…`.
   - In BotFather, optionally run `/setcommands` and paste:
     ```
     start - show the main menu
     setup - set or update your SMS Virtual API key
     balance - show current balance
     order - place an order
     active - list active orders
     history - order history
     deposit - request a deposit
     deposits - deposit history
     favorites - saved service+country combos
     settings - language, defaults, toggles
     help - show help
     cancel - abort the current flow
     ```
2. Your **Telegram numeric user ID**.
   - Talk to [@userinfobot](https://t.me/userinfobot) and copy the `Id` field.
3. An **SMS Virtual API key**.
   - Log in at <https://sms-virtual.net>, open **Profile → API Key**, click
     **Generate** if you don't have one.
4. **Node.js 20+** and a working build toolchain (the installer sets these
   up for you).

---

## Install — Termux on Android

Termux is recommended if you want the bot to run on a phone (low cost,
always online).

```bash
# Install Termux from F-Droid: https://f-droid.org/packages/com.termux/
# Open Termux, then:

pkg update -y
pkg install -y git
git clone https://github.com/smsvirtualnet/smsvirtual-telegram-bot.git
cd smsvirtual-telegram-bot
bash install.sh
```

`install.sh` will install `nodejs-lts`, `python`, `make`, `clang`, and
`sqlite`, run `npm install`, copy `.env.example` to `.env`, and apply
migrations.

Edit `.env` (use `nano .env`) and fill in the required values, then start:

```bash
bash start.sh
```

To keep the bot running after closing Termux, install
[Termux:Boot](https://wiki.termux.com/wiki/Termux:Boot) and add a script in
`~/.termux/boot/` that runs `bash /data/data/com.termux/files/home/smsvirtual-telegram-bot/start.sh`.
Also enable Termux's "Acquire Wakelock" notification action so Android does
not freeze the process.

---

## Install — Linux VPS (Ubuntu / Debian)

```bash
sudo apt-get update
sudo apt-get install -y git
git clone https://github.com/smsvirtualnet/smsvirtual-telegram-bot.git
cd smsvirtual-telegram-bot
bash install.sh
```

`install.sh` will install Node.js 20 from NodeSource if you don't already
have a Node 20+ runtime, plus `build-essential`, `python3`, and `sqlite3`.

Edit `.env`, then run with PM2 for unattended hosting:

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # follow the printed instruction once to enable boot autostart
```

Inspect logs:

```bash
pm2 logs smsvirtual-telegram-bot
tail -f data/pm2.out.log
tail -f data/pm2.err.log
```

---

## Install — Docker / Docker Compose

Use this path when you already run other services in containers and want
the bot to share the same lifecycle, log rotation, and restart policy.

The image is multi-stage (Debian-slim runtime), runs as the non-root `node`
user, and uses [`tini`](https://github.com/krallin/tini) for clean signal
handling. SQLite lives on a bind-mounted `./data` directory so the database
survives container recreation.

```bash
git clone https://example.com/smsvirtual-telegram-bot.git
cd smsvirtual-telegram-bot
cp .env.example .env
nano .env                     # paste TELEGRAM_BOT_TOKEN, ADMIN_TELEGRAM_ID, etc.

# Build + run
docker compose up -d --build

# Tail logs
docker compose logs -f bot

# Update later
git pull
docker compose up -d --build

# Stop
docker compose down
```

If you prefer plain `docker run`:

```bash
docker build -t smsvirtual-telegram-bot:latest .

mkdir -p data && chmod 700 data
docker run -d \
  --name smsvirtual-telegram-bot \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/data:/app/data" \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  smsvirtual-telegram-bot:latest

docker logs -f smsvirtual-telegram-bot
```

Notes:

- The compose file pins the SQLite path inside the container to
  `/app/data/bot.sqlite` regardless of what `DATABASE_FILE` says in `.env`,
  so the database always lands inside the mounted volume.
- The bot runs as user `node` (UID 1000). If your host's `./data` directory
  is owned by a different UID, adjust permissions or run
  `chown -R 1000:1000 data`.
- Backup from the host: `bash backup.sh` still works because it reads
  `data/bot.sqlite` directly. Or, from inside the container:
  `docker compose exec bot sqlite3 /app/data/bot.sqlite .backup /app/data/backup.sqlite`.

---

## Configuration (`.env`)

The installer creates `.env` from `.env.example` and locks it to mode `0600`.
Open it and fill in the values that apply to your install.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token. |
| `ADMIN_TELEGRAM_ID` | yes | Your Telegram numeric ID — the bot owner. |
| `SMSVIRTUAL_API_BASE_URL` | no (default: `https://api.sms-virtual.net`) | Override only for sandbox / mirror. |
| `SMSVIRTUAL_API_KEY` | yes (personal mode) | Your SMS Virtual API key. |
| `SMSVIRTUAL_TIMEOUT_MS` | no | Outbound HTTP timeout (default `15000`). |
| `BOT_ACCESS_MODE` | no | `personal` (default) or `multi`. |
| `ALLOWED_TELEGRAM_IDS` | no | Comma-separated allowlist (multi mode). |
| `OTP_WATCHER_ENABLED` | no | Toggle the OTP watcher (default `true`). |
| `OTP_WATCHER_INTERVAL_MS` | no | Polling interval (default `12000`, min `5000`). |
| `CATALOG_CACHE_TTL_SECONDS` | no | Catalog cache TTL (default `900`). |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | no | Per-user sliding-window rate limit. |
| `ORDER_AUTO_SEARCH_SERVER` | no | Default for the order flow toggle. |
| `ORDER_DEFAULT_QUANTITY` | no | Default order quantity (1–20). |
| `LOG_LEVEL` / `LOG_TO_FILE` | no | `debug` / `info` / `warn` / `error`; file logs to `data/bot.log`. |
| `DATABASE_FILE` | no | SQLite path (default `./data/bot.sqlite`). |
| `DEFAULT_LANGUAGE` | no | `en` for now; Indonesian planned. |

The bot fails fast on startup with a clear message if a required value is
missing.

---

## Running modes: personal vs multi

| Aspect | `personal` | `multi` |
| --- | --- | --- |
| Who can talk to the bot | Only `ADMIN_TELEGRAM_ID` | Admin + allow-listed users |
| API key source | `.env` `SMSVIRTUAL_API_KEY` | Each user runs `/setup` and pastes their own key |
| Allowlist | n/a | `ALLOWED_TELEGRAM_IDS` env, plus admin commands `/users`, `/allow <id>`, `/disallow <id>` |
| Best for | Solo owner, fastest setup | Resellers serving teammates / customers |

Switch modes by editing `BOT_ACCESS_MODE` and restarting the bot.

---

## Bot commands

```
/start         — show main menu
/setup         — set or update your SMS Virtual API key
/balance       — show current balance
/profile       — show account profile
/order         — full multi-step order flow
/order <service> <country> [qty]  — smart order
/active        — list active orders (with action buttons)
/history       — order history
/deposit       — request a new deposit
/deposits      — deposit history
/favorites     — saved service+country combos
/settings      — language, defaults, toggles
/help          — show help
/cancel        — abort the current flow

# Admin (multi mode)
/users
/allow <telegram_id>
/disallow <telegram_id>
```

The same actions are available via the persistent reply keyboard
(`💰 Balance`, `🌍 Order Number`, `📦 Active Orders`, etc.).

---

## Smart `/order` syntax

Skip the multi-step flow when you know exactly what you want:

```
/order whatsapp indonesia
/order whatsapp indonesia 3
/order telegram philippines 2
```

Format: `/order <service-keyword> <country-keyword> [quantity]`. The bot
resolves the keywords against the SMS Virtual catalog, picks the **cheapest
available price tier**, and jumps straight to the confirmation step. You
can change the quantity or toggle auto-search server before pressing
**✅ Confirm & order**.

---

## Running the bot

### Foreground (good for testing / Termux)

```bash
bash start.sh
```

Use `Ctrl+C` to stop.

### PM2 (recommended for VPS)

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup            # one-time autostart setup
pm2 logs smsvirtual-telegram-bot
pm2 stop  smsvirtual-telegram-bot
pm2 restart smsvirtual-telegram-bot
```

### systemd (alternative for VPS)

Create `/etc/systemd/system/smsvirtual-telegram-bot.service`:

```ini
[Unit]
Description=SMS Virtual Telegram Bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/smsvirtual-telegram-bot
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5
User=botuser
EnvironmentFile=/opt/smsvirtual-telegram-bot/.env

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now smsvirtual-telegram-bot
sudo journalctl -u smsvirtual-telegram-bot -f
```

---

## Updating

```bash
bash update.sh
pm2 restart smsvirtual-telegram-bot   # or: bash start.sh
```

`update.sh` runs `git pull`, reinstalls dependencies, and applies any new
database migrations. It does not restart the bot — you do that explicitly.

---

## Backup and restore

The database file lives at `data/bot.sqlite`. Use the helper scripts:

```bash
# Snapshot now (safe to run while the bot is live):
bash backup.sh
# → data/backups/bot-YYYYMMDDTHHMMSSZ.sqlite.gz

# Restore (stop the bot first):
pm2 stop smsvirtual-telegram-bot
bash restore.sh data/backups/bot-YYYYMMDDTHHMMSSZ.sqlite.gz
pm2 start smsvirtual-telegram-bot
```

A simple cron entry for daily backups (Linux VPS):

```cron
30 3 * * *   cd /opt/smsvirtual-telegram-bot && bash backup.sh >> data/backup.log 2>&1
```

---

## Security checklist

- [ ] `.env` is mode `0600` (the installer sets this).
- [ ] `data/` is mode `0700` and lives on encrypted storage if the host is shared.
- [ ] You committed neither `.env` nor `data/*.sqlite*` to version control.
      The bundled `.gitignore` excludes both.
- [ ] You set a strong, unique `TELEGRAM_BOT_TOKEN`. Rotate via BotFather
      with `/revoke` if you suspect a leak.
- [ ] Your SMS Virtual API key is unique to this install. Rotate from the
      SMS Virtual dashboard whenever you give a new operator access to
      this bot, or whenever you sell / decommission a phone running Termux.
- [ ] You set `BOT_ACCESS_MODE=personal` unless you actively need multi
      mode. Personal mode means a stranger who guesses your bot's name
      cannot use it — only your `ADMIN_TELEGRAM_ID` can.
- [ ] In multi mode, prefer using `ALLOWED_TELEGRAM_IDS` to lock the
      allowlist via `.env` (versus letting any new user sign up). The bot
      will still ignore everyone except admin and allow-listed users.
- [ ] You read the logs once a day for the first week (`tail -f data/pm2.out.log`)
      to confirm there are no `Unauthorized` or `RATE_LIMITED` errors.

What the bot **does not** log:

- Full SMS Virtual API keys (they are masked to `abcd****wxyz`).
- Telegram tokens.
- OTP codes (only their masked form appears in debug logs).
- Phone-number middles (only the country prefix and last three digits are
  shown).

---

## Troubleshooting

### The bot won't start

Run it in the foreground and read the first error:

```bash
node src/index.js
```

Common causes:

- `[config] TELEGRAM_BOT_TOKEN is missing` — open `.env` and paste the token.
- `[config] ADMIN_TELEGRAM_ID is missing or not a number` — paste your
  numeric Telegram ID (no `@username`).
- `[config] SMSVIRTUAL_API_KEY is required in personal mode` — paste your
  SMS Virtual API key, or switch to `BOT_ACCESS_MODE=multi`.

### `Error: Cannot find module 'better-sqlite3'`

Build tools were missing at install time. On Termux:

```bash
pkg install -y python make clang
rm -rf node_modules
npm install --omit=dev
```

On Debian/Ubuntu:

```bash
sudo apt-get install -y build-essential python3
rm -rf node_modules
npm install --omit=dev
```

### "❌ The API key was rejected by SMS Virtual"

- Re-open the SMS Virtual dashboard and confirm the key is the latest.
- Generate a new key, run `/setup`, paste the new value.
- Check the `SMSVIRTUAL_API_BASE_URL` is `https://api.sms-virtual.net` (or
  the sandbox you actually want).

### "❌ Out of stock" / "No matching numbers"

The selected price tier or operator combination doesn't have inventory. Try:

- Switch operator to **Any operator**.
- Pick a different price tier (the order flow shows them sorted cheapest
  first — sometimes the cheapest tier has zero stock).
- Toggle **Auto-search server** in the confirm step.

### OTPs never arrive

- Confirm the watcher is enabled (`/settings` → `OTP watcher`).
- Confirm the bot user has `is_allowed = 1` in the database
  (`sqlite3 data/bot.sqlite 'SELECT * FROM users;'`).
- Watch logs: `tail -f data/pm2.out.log` while the user has an active
  activation. You should see `getStatus` entries every ~12s.

### Rate-limited (`429`)

The bot retries automatically a few times, but if you keep hitting limits,
loosen `RATE_LIMIT_*` in `.env` and consider increasing
`OTP_WATCHER_INTERVAL_MS` (e.g. from `12000` to `20000`).

### The database is locked

Stop the bot first, then run any external `sqlite3` command. WAL mode
allows reads while the bot is running, but writes from a second process
will fail.

---

## Project layout

```
smsvirtual-telegram-bot/
├── package.json
├── ecosystem.config.js          # PM2 process config
├── Dockerfile                   # multi-stage image build
├── docker-compose.yml           # one-command Docker deployment
├── .dockerignore
├── install.sh / start.sh / update.sh / backup.sh / restore.sh
├── .env.example                 # template for .env
├── data/                        # SQLite DB, logs, PM2 logs (created on first run)
└── src/
    ├── index.js                 # entrypoint
    ├── config.js                # env loader + validator
    ├── api/                     # axios client + per-feature endpoint wrappers
    │   ├── client.js
    │   ├── accountApi.js        # profile, balance, balance/history
    │   ├── catalogApi.js        # countries, operators, services, services/list
    │   ├── orderApi.js          # orders/* endpoints
    │   └── depositApi.js        # deposits/* endpoints
    ├── bot/
    │   ├── session.js           # in-memory session store + middleware
    │   ├── middlewares.js       # access guard, rate limiter, error handler
    │   ├── menus.js             # inline / reply keyboards
    │   ├── commands.js          # /command and reply-keyboard handlers
    │   └── callbacks.js         # callback_query dispatcher
    ├── flows/
    │   ├── setupFlow.js         # /setup
    │   ├── orderFlow.js         # /order (multi-step + smart)
    │   ├── activeOrderFlow.js   # /active + per-activation actions
    │   ├── depositFlow.js       # /deposit
    │   ├── favoriteFlow.js      # /favorites
    │   └── settingsFlow.js      # /settings
    ├── jobs/
    │   ├── otpWatcher.js        # polls activations, pushes OTPs
    │   └── cacheRefresher.js    # purges + warms catalog cache
    ├── db/
    │   ├── database.js          # better-sqlite3 singleton
    │   ├── migrations.js        # numbered, transactional migrations
    │   └── repositories.js      # CRUD per table
    └── utils/
        ├── config.js
        ├── errors.js            # ApiError + fromAxiosError translator
        ├── formatter.js         # Telegram-friendly text formatters
        ├── logger.js            # leveled logger w/ deep-redaction
        ├── sanitizer.js         # mask helpers (api key, phone, OTP)
        └── validator.js         # input validation + smart command parser
```

---

## License

MIT © 2026. This is the SMS Virtual Telegram Bot, a self-hosted client for
the SMS Virtual public API. The author is not affiliated with Telegram.
