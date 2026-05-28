"use strict";

/**
 * OTP watcher.
 *
 * Polls SMS Virtual for OTPs on every active activation across every user with
 * an API key. When a new OTP arrives, the bot pushes a notification to the
 * owning Telegram user.
 *
 * Design notes:
 * - One global interval (config.otpWatcher.intervalMs) drives all users.
 * - Per-call concurrency is limited to avoid bursting the API.
 * - Per-user OTP watcher can be disabled via `settings.otp_watcher_enabled`.
 * - A row's OTP is considered "new" when the API returns a non-empty value
 *   AND `orders.last_otp` is empty / different. We mark `otp_notified = 1`
 *   afterwards so we never spam the user with duplicates.
 * - Errors (rate limit, network, expired key) are logged and the loop keeps
 *   running.
 */

const config = require("../config");
const logger = require("../utils/logger");
const sanitizer = require("../utils/sanitizer");
const formatter = require("../utils/formatter");
const orderApi = require("../api/orderApi");
const { ordersRepo, settingsRepo, usersRepo } = require("../db/repositories");
const { ApiError } = require("../utils/errors");

let pollHandle = null;
let running = false;
let telegramSender = null;

const TERMINAL_STATUSES = new Set([3, 4, 5, 6, 7, 8]); // SUCCESS, COMPLETED, CANCELLED, EXPIRED, REFUNDED, CANCELLED_BUT_WAITING_CONFIRM

const PER_TICK_CONCURRENCY = 4;

function start({ telegram }) {
  if (!config.otpWatcher.enabled) {
    logger.info("OTP watcher: disabled via config");
    return;
  }
  if (pollHandle) return;

  telegramSender = telegram;
  const intervalMs = Math.max(5000, config.otpWatcher.intervalMs);
  logger.info(`OTP watcher: starting (every ${intervalMs}ms)`);

  // Run shortly after start so users see fast feedback after a restart.
  setTimeout(tick, 2000).unref();
  pollHandle = setInterval(tick, intervalMs);
  pollHandle.unref();
}

function stop() {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

async function tick() {
  if (running) return; // skip if previous tick is still going.
  running = true;
  try {
    const rows = ordersRepo.listActiveAcrossUsers(500);
    if (!rows.length) return;

    // Group by telegram_id so we can short-circuit per-user disables.
    const byUser = new Map();
    for (const row of rows) {
      if (!row.activation_id) continue;
      const list = byUser.get(row.telegram_id) || [];
      list.push(row);
      byUser.set(row.telegram_id, list);
    }

    for (const [telegramId, list] of byUser.entries()) {
      const settings = settingsRepo.getOrCreate(telegramId);
      if (!settings.otp_watcher_enabled) continue;

      const user = usersRepo.findByTelegramId(telegramId);
      if (!user || !user.api_key || !user.is_allowed) continue;

      await processChunk(telegramId, list);
    }
  } catch (err) {
    logger.warn("otpWatcher.tick error", { err: err.message });
  } finally {
    running = false;
  }
}

async function processChunk(telegramId, list) {
  // Fan out within a small concurrency window.
  let cursor = 0;
  const workers = new Array(Math.min(PER_TICK_CONCURRENCY, list.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);

  async function worker() {
    while (cursor < list.length) {
      const row = list[cursor++];
      try {
        await checkRow(telegramId, row);
      } catch (err) {
        if (err instanceof ApiError && err.code === "Unauthorized") {
          logger.warn("otpWatcher: API key rejected — pausing user", {
            telegramId,
          });
          break; // stop iterating this user this tick
        }
        logger.debug("otpWatcher.checkRow error", {
          telegramId,
          activationId: row.activation_id,
          err: err.message,
        });
      }
    }
  }
}

async function checkRow(telegramId, row) {
  const id = row.activation_id;
  const data = await orderApi.getStatus({ telegramId, id });

  let otpText = null;
  let activation = null;

  if (typeof data === "string") {
    otpText = data;
  } else if (data && typeof data === "object") {
    activation = data;
    otpText = data.otp || data.code || null;
  }

  // Persist any status change.
  if (activation) {
    try {
      ordersRepo.upsertFromActivation(telegramId, {
        ...activation,
        id: activation.id || id,
      });
    } catch (err) {
      logger.warn("otpWatcher: failed to upsert activation", { err: err.message });
    }
  }

  if (!otpText) return;

  // Skip if we already notified the user about this exact OTP.
  if (row.last_otp && row.otp_notified && row.last_otp === otpText) return;

  ordersRepo.setOtp(row.id, otpText, true);

  // Re-fetch the row so we have up-to-date display fields.
  const fresh = ordersRepo.findById(row.id);

  await sendOtpToUser(telegramId, fresh || row, otpText);

  // If the activation is now in a terminal state, stop watching.
  if (
    activation &&
    activation.status !== undefined &&
    activation.status !== null &&
    TERMINAL_STATUSES.has(Number(activation.status))
  ) {
    ordersRepo.updateStatus(row.id, activation.status);
  }
}

async function sendOtpToUser(telegramId, row, otpText) {
  if (!telegramSender) return;
  try {
    await telegramSender.sendMessage(
      telegramId,
      formatter.formatOtpNotification(
        {
          phoneNumber: row.phone_number,
          serviceName: row.service_name,
          countryName: row.country_name,
        },
        otpText
      ),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    // Common failures: bot was blocked by user, chat closed.
    logger.warn("otpWatcher: failed to deliver OTP", {
      telegramId,
      maskedOtp: sanitizer.maskOtp(otpText),
      err: err.message,
    });
  }
}

module.exports = {
  start,
  stop,
  tick, // exposed for tests / manual triggers
};
