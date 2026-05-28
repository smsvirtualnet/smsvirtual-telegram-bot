"use strict";

/**
 * /setup flow — collect a SMS Virtual API key, validate it, persist it.
 *
 * Stages:
 *   awaiting_api_key   — bot is waiting for the user to paste their key.
 */

const config = require("../config");
const logger = require("../utils/logger");
const validator = require("../utils/validator");
const sanitizer = require("../utils/sanitizer");
const accountApi = require("../api/accountApi");
const { ApiError } = require("../utils/errors");
const { usersRepo, settingsRepo } = require("../db/repositories");
const { setupKeyboard, mainMenu } = require("../bot/menus");

const STAGE = "setup:awaiting_api_key";

async function startSetup(ctx) {
  const helpLink =
    "Open https://sms-virtual.net , log in, then go to Profile → API Key.";

  if (config.bot.accessMode === "personal" && !ctx.isAdmin) {
    await ctx.reply("Only the bot owner can configure the API key.");
    return;
  }

  ctx.setStage(STAGE, {});
  await ctx.reply(
    "🔑 <b>Set your SMS Virtual API key</b>\n\n" +
      "Paste your <b>x-api-key</b> in the next message.\n\n" +
      `${helpLink}\n\n` +
      "Tip: rotate your key any time from the SMS Virtual dashboard. The bot " +
      "will never display the full key after it has been saved.",
    { parse_mode: "HTML" }
  );
}

async function showHelp(ctx) {
  await ctx.reply(
    "How to get your SMS Virtual API key:\n\n" +
      "1. Sign up / log in at https://sms-virtual.net\n" +
      "2. Open Profile → API Key.\n" +
      "3. Click <b>Generate</b> (or copy the existing key).\n" +
      "4. Run /setup here in the bot and paste the key.\n\n" +
      "The key never leaves your device — it is stored locally in this bot's SQLite file.",
    { parse_mode: "HTML" }
  );
}

async function handleApiKeyMessage(ctx) {
  const text = (ctx.message && ctx.message.text) || "";
  const apiKey = text.trim();

  if (!validator.isValidApiKeyFormat(apiKey)) {
    await ctx.reply(
      "❌ That does not look like a valid SMS Virtual API key. Please paste " +
        "the key again, or run /help."
    );
    return;
  }

  await ctx.reply("⏳ Validating your API key …");

  try {
    const profile = await accountApi.getProfile({
      telegramId: ctx.from.id,
      apiKeyOverride: apiKey,
    });

    usersRepo.saveApiKey(ctx.from.id, apiKey);
    settingsRepo.getOrCreate(ctx.from.id, {
      defaultQuantity: config.order.defaultQuantity,
      autoSearchServer: config.order.autoSearchServer,
      otpWatcherEnabled: config.otpWatcher.enabled,
      language: config.bot.defaultLanguage,
    });
    ctx.clearStage();

    const masked = sanitizer.maskApiKey(apiKey);
    const greeting =
      `✅ <b>API key saved</b>\n` +
      `Saved as: <code>${masked}</code>\n\n` +
      `<b>Profile</b>\n` +
      `Name: ${profile.name || "—"}\n` +
      `Email: <code>${profile.email || "—"}</code>\n` +
      `Status: ${profile.status === 1 ? "🟢 ACTIVE" : "⚪ INACTIVE"}\n\n` +
      `Open the menu below to start ordering.`;

    await ctx.reply(greeting, {
      parse_mode: "HTML",
      ...mainMenu(ctx.isAdmin),
    });
  } catch (err) {
    logger.warn("Setup: API key validation failed", {
      err: err && err.message,
      code: err instanceof ApiError ? err.code : null,
    });
    if (err instanceof ApiError && err.code === "Unauthorized") {
      await ctx.reply(
        "❌ The API key was rejected by SMS Virtual. Double-check that you " +
          "copied the full key, or generate a new one in your dashboard."
      );
    } else {
      await ctx.reply(
        `❌ Could not validate the API key: ${err && err.friendly ? err.friendly : err.message}`
      );
    }
    // keep the stage so the user can paste again
  }
}

function isAwaitingApiKey(ctx) {
  return ctx.session && ctx.session.stage === STAGE;
}

module.exports = {
  STAGE,
  startSetup,
  showHelp,
  handleApiKeyMessage,
  isAwaitingApiKey,
};
