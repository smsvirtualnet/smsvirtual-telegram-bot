"use strict";

/**
 * Process entrypoint.
 *
 * Boot order:
 *   1. Load + validate config (config.js exits on failure)
 *   2. Open SQLite, run migrations
 *   3. Build the Telegraf bot, attach middlewares + handlers
 *   4. Launch the bot (long polling)
 *   5. Start jobs (OTP watcher, cache refresher)
 *   6. Wire signal handlers for graceful shutdown
 *
 * Run with:
 *   node src/index.js          # foreground
 *   pm2 start ecosystem.config.js
 */

const { Telegraf } = require("telegraf");

const config = require("./config");
const logger = require("./utils/logger");
const { getDatabase, closeDatabase } = require("./db/database");
const { runMigrations } = require("./db/migrations");

const { sessionMiddleware } = require("./bot/session");
const {
  accessGuard,
  rateLimiter,
  errorHandler,
} = require("./bot/middlewares");
const commands = require("./bot/commands");
const callbacks = require("./bot/callbacks");

const otpWatcher = require("./jobs/otpWatcher");
const cacheRefresher = require("./jobs/cacheRefresher");

let bot = null;
let shuttingDown = false;

async function main() {
  // 1. DB + migrations.
  const db = getDatabase();
  runMigrations(db);
  logger.info(`Database ready: ${config.database.file}`);

  // 2. Telegraf instance.
  bot = new Telegraf(config.telegram.token, {
    handlerTimeout: 90_000,
  });

  // 3. Global middlewares (order matters).
  bot.use(errorHandler());
  bot.use(sessionMiddleware());
  bot.use(accessGuard());
  bot.use(rateLimiter());

  // 4. Commands first (text), then catch-all callback dispatch.
  commands.register(bot);
  callbacks.register(bot);

  // 5. Telegraf-level error catcher (fires when even the errorHandler
  //    middleware re-throws).
  bot.catch((err, ctx) => {
    logger.error("Unhandled bot.catch error", {
      err: err && err.message,
      stack: err && err.stack,
      update: ctx && ctx.updateType,
    });
  });

  // 6. Launch the bot.
  await bot.launch({
    dropPendingUpdates: true,
  });

  logger.info(`Bot launched in ${config.bot.accessMode} mode`);
  logger.info(
    `API base URL: ${config.api.baseUrl} · timeout ${config.api.timeoutMs}ms`
  );

  // 7. Background jobs.
  cacheRefresher.start();
  otpWatcher.start({ telegram: bot.telegram });

  // 8. Shutdown wiring.
  const shutdown = (signal) => () => gracefulShutdown(signal);
  process.once("SIGINT", shutdown("SIGINT"));
  process.once("SIGTERM", shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error("uncaughtException", { err: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandledRejection", { reason: String(reason) });
  });
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down …`);

  try {
    otpWatcher.stop();
  } catch (err) {
    logger.warn("otpWatcher.stop failed", { err: err.message });
  }
  try {
    cacheRefresher.stop();
  } catch (err) {
    logger.warn("cacheRefresher.stop failed", { err: err.message });
  }
  try {
    if (bot) bot.stop(signal);
  } catch (err) {
    logger.warn("bot.stop failed", { err: err.message });
  }
  try {
    closeDatabase();
  } catch (err) {
    logger.warn("closeDatabase failed", { err: err.message });
  }

  // Give the runtime a beat to flush buffers, then exit.
  setTimeout(() => process.exit(0), 250).unref();
}

// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    logger.error("Fatal startup error", { err: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { main, gracefulShutdown };
