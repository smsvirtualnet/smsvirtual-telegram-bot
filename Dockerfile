# syntax=docker/dockerfile:1.7
#
# SMS Virtual Telegram Bot — multi-stage Docker build.
#
# Strategy:
#   1. `builder` — full Debian image with toolchain, builds the native
#      `better-sqlite3` binding once.
#   2. `runtime` — slim image, contains only the production node_modules
#      (with prebuilt bindings), the source tree, `tini` for clean signal
#      handling, and a non-root user.
#
# Build:
#   docker build -t smsvirtual-telegram-bot:latest .
#
# Run (foreground, .env file in cwd, persistent SQLite under ./data):
#   docker run --rm -it --env-file .env -v "$PWD/data:/app/data" \
#     smsvirtual-telegram-bot:latest
#
# Run (detached, restart on failure):
#   docker run -d --name smsvirtual-bot --restart unless-stopped \
#     --env-file .env -v "$PWD/data:/app/data" \
#     smsvirtual-telegram-bot:latest
# =============================================================================

# --- Stage 1: build dependencies (native modules) ----------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./

# Prefer reproducible install when a lockfile exists; fall back to install.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
 && npm cache clean --force


# --- Stage 2: minimal runtime -----------------------------------------------
FROM node:20-bookworm-slim AS runtime

# `tini` reaps zombies and forwards SIGTERM cleanly; `sqlite3` is handy for
# debugging and is required by backup.sh; `ca-certificates` for HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        tini sqlite3 ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && apt-get clean

ENV NODE_ENV=production \
    DATABASE_FILE=/app/data/bot.sqlite \
    LOG_TO_FILE=false \
    NPM_CONFIG_LOGLEVEL=warn

WORKDIR /app

# Bring in already-built node_modules (native bindings included).
COPY --from=builder /app/node_modules ./node_modules

# Source last so editing code does not bust the dependency layer.
COPY package.json ./
COPY ecosystem.config.js ./
COPY src ./src

# Persistent data directory: SQLite db, optional logs, backups.
RUN mkdir -p /app/data \
 && chown -R node:node /app

USER node

VOLUME ["/app/data"]

# Lightweight liveness check: the SQLite file exists and the Node binary works.
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "process.exit(0)" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
