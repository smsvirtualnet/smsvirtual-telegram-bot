"use strict";

/**
 * Telegraf middlewares: access control, rate limiting, error handling.
 */

const config = require("../config");
const logger = require("../utils/logger");
const { ApiError, toFriendlyMessage } = require("../utils/errors");
const { usersRepo } = require("../db/repositories");

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

function isAdmin(telegramId) {
  return Number(telegramId) === Number(config.telegram.adminId);
}

function isInAllowlist(telegramId) {
  return config.telegram.allowedIds.includes(Number(telegramId));
}

function isUserAllowed(telegramId) {
  const id = Number(telegramId);
  if (!Number.isFinite(id)) return false;
  if (isAdmin(id)) return true;

  if (config.bot.accessMode === "personal") {
    return false;
  }

  // multi-mode
  if (isInAllowlist(id)) return true;
  const row = usersRepo.findByTelegramId(id);
  return !!(row && row.is_allowed);
}

function accessGuard() {
  return async function (ctx, next) {
    const telegramId = ctx.from && ctx.from.id;

    if (!telegramId) return; // ignore updates without a known user.

    // Always upsert the user record so the bot can show usage stats.
    try {
      usersRepo.upsertFromTelegram({
        telegramId,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
      });
    } catch (err) {
      logger.warn("Failed to upsert user", { err: err.message });
    }

    if (isUserAllowed(telegramId)) {
      ctx.isAdmin = isAdmin(telegramId);
      return next();
    }

    // Friendly refusal.
    if (config.bot.accessMode === "personal") {
      await safeReply(
        ctx,
        "🚫 This is a private bot. Only the bot owner can use it.\n" +
          "If you are the owner, double-check your ADMIN_TELEGRAM_ID in .env."
      );
    } else {
      await safeReply(
        ctx,
        "🚫 You are not on the allowlist for this bot.\n" +
          "Ask the bot admin to add your Telegram ID."
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Rate limiting (per Telegram user, sliding window)
// ---------------------------------------------------------------------------

const buckets = new Map();

function rateLimiter() {
  const windowMs = config.bot.rateLimit.windowMs;
  const max = config.bot.rateLimit.max;

  return async function (ctx, next) {
    const id = ctx.from && ctx.from.id;
    if (!id) return next();
    if (isAdmin(id)) return next(); // never throttle the admin.

    const now = Date.now();
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { stamps: [] };
      buckets.set(id, bucket);
    }
    bucket.stamps = bucket.stamps.filter((t) => now - t < windowMs);
    if (bucket.stamps.length >= max) {
      const retryIn = Math.max(0, windowMs - (now - bucket.stamps[0]));
      await safeReply(
        ctx,
        `⏳ Slow down — you are sending requests too fast. Try again in ${Math.ceil(
          retryIn / 1000
        )}s.`
      );
      return;
    }
    bucket.stamps.push(now);
    return next();
  };
}

// Clean buckets every 5 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of buckets.entries()) {
    bucket.stamps = bucket.stamps.filter((t) => now - t < config.bot.rateLimit.windowMs);
    if (bucket.stamps.length === 0) buckets.delete(id);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Catch-all error handler
// ---------------------------------------------------------------------------

function errorHandler() {
  return async function (ctx, next) {
    try {
      await next();
    } catch (err) {
      const friendly =
        err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
      logger.error("Unhandled handler error", {
        err: err.message,
        stack: err.stack,
        update: ctx.updateType,
      });
      await safeReply(ctx, `⚠️ ${friendly}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function safeReply(ctx, text, extra) {
  try {
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCbQuery();
      } catch (_) {
        // ignore
      }
    }
    await ctx.reply(text, extra);
  } catch (err) {
    logger.warn("Failed to reply", { err: err.message });
  }
}

module.exports = {
  accessGuard,
  rateLimiter,
  errorHandler,
  isAdmin,
  isUserAllowed,
};
