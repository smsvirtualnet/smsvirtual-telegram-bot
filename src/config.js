"use strict";

/**
 * SMS Virtual Telegram Bot — runtime configuration.
 *
 * Loads `.env`, validates the values, and exposes an immutable `config` object
 * the rest of the codebase can rely on. Designed so the bot fails fast with a
 * clear error if anything important is missing.
 */

const path = require("path");
const fs = require("fs");

// Load .env (do not crash if the file is missing — installer will create it).
require("dotenv").config({
  path: path.resolve(__dirname, "..", ".env"),
});

const PROJECT_ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function asInt(value, fallback) {
  const n = parseInt(asString(value), 10);
  if (Number.isFinite(n)) return n;
  return fallback;
}

function asBool(value, fallback = false) {
  const v = asString(value).toLowerCase();
  if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
  if (v === "false" || v === "0" || v === "no" || v === "n") return false;
  return fallback;
}

function asList(value) {
  return asString(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ensure(condition, message) {
  if (!condition) {
    // eslint-disable-next-line no-console
    console.error(`[config] ${message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Resolve values
// ---------------------------------------------------------------------------

const accessMode = (() => {
  const raw = asString(process.env.BOT_ACCESS_MODE, "personal").toLowerCase();
  return raw === "multi" ? "multi" : "personal";
})();

const adminTelegramIdRaw = asString(process.env.ADMIN_TELEGRAM_ID);
const adminTelegramId =
  adminTelegramIdRaw && /^\d+$/.test(adminTelegramIdRaw)
    ? Number(adminTelegramIdRaw)
    : null;

const allowedTelegramIds = asList(process.env.ALLOWED_TELEGRAM_IDS)
  .filter((id) => /^\d+$/.test(id))
  .map((id) => Number(id));

const databaseFile = (() => {
  const raw = asString(process.env.DATABASE_FILE, "./data/bot.sqlite");
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_ROOT, raw);
})();

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

ensure(
  asString(process.env.TELEGRAM_BOT_TOKEN).length > 10,
  "TELEGRAM_BOT_TOKEN is missing. Get a token from @BotFather and put it in .env."
);

ensure(
  adminTelegramId !== null,
  "ADMIN_TELEGRAM_ID is missing or not a number. Find your numeric Telegram ID via @userinfobot."
);

ensure(
  /^https?:\/\//.test(asString(process.env.SMSVIRTUAL_API_BASE_URL, "https://api.sms-virtual.net")),
  "SMSVIRTUAL_API_BASE_URL must be a valid http(s) URL."
);

if (accessMode === "personal") {
  // In personal mode the SMS Virtual API key is required up-front (the admin
  // can still rotate it later via /setup, but we want a working bot from the
  // first start).
  ensure(
    asString(process.env.SMSVIRTUAL_API_KEY).length > 0,
    "SMSVIRTUAL_API_KEY is required in personal mode. Set it in .env or run `/setup` after start."
  );
}

// Make sure the data directory exists so SQLite + logger can write to it.
const dataDir = path.dirname(databaseFile);
fs.mkdirSync(dataDir, { recursive: true });

// ---------------------------------------------------------------------------
// Final immutable config object
// ---------------------------------------------------------------------------

const config = Object.freeze({
  projectRoot: PROJECT_ROOT,
  dataDir,

  telegram: Object.freeze({
    token: asString(process.env.TELEGRAM_BOT_TOKEN),
    adminId: adminTelegramId,
    allowedIds: Object.freeze(allowedTelegramIds),
  }),

  api: Object.freeze({
    baseUrl: asString(
      process.env.SMSVIRTUAL_API_BASE_URL,
      "https://api.sms-virtual.net"
    ).replace(/\/+$/, ""),
    defaultApiKey: asString(process.env.SMSVIRTUAL_API_KEY),
    timeoutMs: asInt(process.env.SMSVIRTUAL_TIMEOUT_MS, 15000),
  }),

  bot: Object.freeze({
    accessMode, // "personal" | "multi"
    defaultLanguage: asString(process.env.DEFAULT_LANGUAGE, "en").toLowerCase(),
    rateLimit: Object.freeze({
      windowMs: asInt(process.env.RATE_LIMIT_WINDOW_MS, 10000),
      max: asInt(process.env.RATE_LIMIT_MAX, 20),
    }),
  }),

  order: Object.freeze({
    autoSearchServer: asBool(process.env.ORDER_AUTO_SEARCH_SERVER, true),
    defaultQuantity: Math.max(
      1,
      Math.min(20, asInt(process.env.ORDER_DEFAULT_QUANTITY, 1))
    ),
  }),

  otpWatcher: Object.freeze({
    enabled: asBool(process.env.OTP_WATCHER_ENABLED, true),
    intervalMs: Math.max(
      5000,
      asInt(process.env.OTP_WATCHER_INTERVAL_MS, 12000)
    ),
  }),

  cache: Object.freeze({
    catalogTtlSeconds: Math.max(
      60,
      asInt(process.env.CATALOG_CACHE_TTL_SECONDS, 900)
    ),
  }),

  logging: Object.freeze({
    level: asString(process.env.LOG_LEVEL, "info").toLowerCase(),
    toFile: asBool(process.env.LOG_TO_FILE, false),
    file: path.join(dataDir, "bot.log"),
  }),

  database: Object.freeze({
    file: databaseFile,
  }),
});

module.exports = config;
