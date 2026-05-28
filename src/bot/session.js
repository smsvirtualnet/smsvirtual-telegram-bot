"use strict";

/**
 * In-memory session store keyed by Telegram user id.
 *
 * Sessions hold short-lived state for multi-step flows (setup, order, deposit,
 * settings). They are NOT a persistence layer — anything that should survive
 * a restart must be written to SQLite via the repositories.
 *
 * The session middleware injects a `ctx.session` proxy onto every Telegraf
 * update, plus convenience helpers `ctx.setStage(...)` / `ctx.clearStage()`.
 */

const sessions = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 minutes — abandoned flows die quietly.

function nowExpiry() {
  return Date.now() + TTL_MS;
}

function getOrCreate(telegramId) {
  if (!telegramId) return null;
  const existing = sessions.get(telegramId);
  if (existing && existing.__expiresAt > Date.now()) {
    existing.__expiresAt = nowExpiry();
    return existing;
  }
  const fresh = {
    stage: null,
    data: {},
    __expiresAt: nowExpiry(),
  };
  sessions.set(telegramId, fresh);
  return fresh;
}

function clear(telegramId) {
  sessions.delete(telegramId);
}

function setStage(telegramId, stage, patch = {}) {
  const session = getOrCreate(telegramId);
  session.stage = stage;
  session.data = { ...(session.data || {}), ...patch };
  return session;
}

function clearStage(telegramId) {
  const session = sessions.get(telegramId);
  if (session) {
    session.stage = null;
    session.data = {};
  }
}

/** Telegraf middleware factory. */
function sessionMiddleware() {
  return async function (ctx, next) {
    const telegramId = ctx.from && ctx.from.id;
    if (telegramId) {
      ctx.session = getOrCreate(telegramId);
      ctx.setStage = (stage, patch) => setStage(telegramId, stage, patch);
      ctx.clearStage = () => clearStage(telegramId);
    } else {
      ctx.session = { stage: null, data: {} };
      ctx.setStage = () => {};
      ctx.clearStage = () => {};
    }
    return next();
  };
}

// Periodic GC to keep memory tiny.
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions.entries()) {
    if (sess.__expiresAt < now) sessions.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  sessionMiddleware,
  getOrCreate,
  clear,
  setStage,
  clearStage,
};
