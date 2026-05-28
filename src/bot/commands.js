"use strict";

/**
 * Top-level command and message handlers.
 *
 * `register(bot)` attaches every /command and reply-keyboard text handler.
 * Multi-step flow text input (setup, order, deposit, settings) is forwarded
 * to the appropriate flow module via `dispatchTextDuringFlow`.
 */

const config = require("../config");
const logger = require("../utils/logger");
const formatter = require("../utils/formatter");
const validator = require("../utils/validator");
const accountApi = require("../api/accountApi");
const orderApi = require("../api/orderApi");
const { usersRepo } = require("../db/repositories");

const menus = require("./menus");
const setupFlow = require("../flows/setupFlow");
const orderFlow = require("../flows/orderFlow");
const activeOrderFlow = require("../flows/activeOrderFlow");
const depositFlow = require("../flows/depositFlow");
const favoriteFlow = require("../flows/favoriteFlow");
const settingsFlow = require("../flows/settingsFlow");
const { ApiError, toFriendlyMessage } = require("../utils/errors");

function register(bot) {
  // -------------------------------------------------------------------------
  // /start, /help
  // -------------------------------------------------------------------------

  bot.start(async (ctx) => {
    const user = usersRepo.findByTelegramId(ctx.from.id);
    const hasKey =
      !!(user && user.api_key) || !!config.api.defaultApiKey;
    const greeting = [
      "👋 <b>Welcome to SMS Virtual Telegram Bot</b>",
      "",
      "This bot lets you rent virtual phone numbers for SMS verification, top up your balance, and watch incoming OTPs — all from Telegram.",
      "",
      hasKey
        ? "✅ Your API key is configured. Pick an action from the menu below."
        : "🔑 Your API key is not configured yet. Run /setup to add one.",
      "",
      "Run /help to see every command.",
    ].join("\n");
    await ctx.reply(greeting, {
      parse_mode: "HTML",
      ...menus.mainMenu(ctx.isAdmin),
    });
  });

  bot.help(async (ctx) => sendHelp(ctx));
  bot.command("help", async (ctx) => sendHelp(ctx));

  // -------------------------------------------------------------------------
  // /setup
  // -------------------------------------------------------------------------

  bot.command("setup", async (ctx) => setupFlow.startSetup(ctx));

  // -------------------------------------------------------------------------
  // /balance, /profile
  // -------------------------------------------------------------------------

  bot.command("balance", async (ctx) => sendBalance(ctx));
  bot.command("profile", async (ctx) => sendProfile(ctx));

  // -------------------------------------------------------------------------
  // /order [service] [country] [quantity]
  // -------------------------------------------------------------------------

  bot.command("order", async (ctx) => {
    const text = (ctx.message && ctx.message.text) || "";
    const parsed = validator.parseSmartOrderArgs(text);
    if (parsed) {
      try {
        await orderFlow.startSmartOrder(ctx, parsed);
      } catch (err) {
        await replyError(ctx, err);
      }
      return;
    }
    try {
      await orderFlow.startOrder(ctx);
    } catch (err) {
      await replyError(ctx, err);
    }
  });

  // -------------------------------------------------------------------------
  // /active, /history, /deposit, /favorites, /settings
  // -------------------------------------------------------------------------

  bot.command("active", async (ctx) => activeOrderFlow.listActive(ctx));
  bot.command("history", async (ctx) => sendOrderHistory(ctx, 1));
  bot.command("deposit", async (ctx) => depositFlow.startDeposit(ctx));
  bot.command("deposits", async (ctx) => depositFlow.showHistory(ctx, 1));
  bot.command("favorites", async (ctx) => favoriteFlow.showFavorites(ctx));
  bot.command("settings", async (ctx) => settingsFlow.showSettings(ctx));
  bot.command("cancel", async (ctx) => {
    ctx.clearStage();
    await ctx.reply("Flow cancelled.", { ...menus.mainMenu(ctx.isAdmin) });
  });

  // -------------------------------------------------------------------------
  // Admin commands: /allow, /disallow, /users
  // -------------------------------------------------------------------------

  bot.command("users", async (ctx) => settingsFlow.listAllowedUsers(ctx));

  bot.command("allow", async (ctx) => {
    const arg = stripCommand(ctx.message.text || "");
    await settingsFlow.allowUser(ctx, arg);
  });

  bot.command("disallow", async (ctx) => {
    const arg = stripCommand(ctx.message.text || "");
    await settingsFlow.disallowUser(ctx, arg);
  });

  // -------------------------------------------------------------------------
  // Reply-keyboard buttons (text equivalents of slash commands)
  // -------------------------------------------------------------------------

  bot.hears("💰 Balance", async (ctx) => sendBalance(ctx));
  bot.hears("🌍 Order Number", async (ctx) => orderFlow.startOrder(ctx));
  bot.hears("📦 Active Orders", async (ctx) => activeOrderFlow.listActive(ctx));
  bot.hears("📜 Order History", async (ctx) => sendOrderHistory(ctx, 1));
  bot.hears("💳 Deposit", async (ctx) => depositFlow.startDeposit(ctx));
  bot.hears("⭐ Favorites", async (ctx) => favoriteFlow.showFavorites(ctx));
  bot.hears("⚙️ Settings", async (ctx) => settingsFlow.showSettings(ctx));
  bot.hears("❓ Help", async (ctx) => sendHelp(ctx));
  bot.hears("👥 Admin: Users", async (ctx) => settingsFlow.listAllowedUsers(ctx));

  // -------------------------------------------------------------------------
  // Catch-all text — route to the active flow.
  // -------------------------------------------------------------------------

  bot.on("text", async (ctx) => dispatchTextDuringFlow(ctx));
}

// ===========================================================================
// Text dispatcher
// ===========================================================================

async function dispatchTextDuringFlow(ctx) {
  if (setupFlow.isAwaitingApiKey(ctx)) {
    return setupFlow.handleApiKeyMessage(ctx);
  }
  if (depositFlow.isAwaitingAmount(ctx)) {
    return depositFlow.handleAmountMessage(ctx);
  }
  if (settingsFlow.isAwaitingValue(ctx)) {
    return settingsFlow.handleValueMessage(ctx);
  }
  if (await orderFlow.handleTextDuringFlow(ctx)) {
    return;
  }
  // Default: nudge.
  await ctx.reply(
    "I didn't catch that. Tap a menu button or run /help.",
    { ...menus.mainMenu(ctx.isAdmin) }
  );
}

// ===========================================================================
// Handlers used by both /command and reply-keyboard
// ===========================================================================

async function sendBalance(ctx) {
  try {
    const balance = await accountApi.getBalance({ telegramId: ctx.from.id });
    await ctx.reply(formatter.formatBalance(balance), { parse_mode: "HTML" });
  } catch (err) {
    await replyError(ctx, err);
  }
}

async function sendProfile(ctx) {
  try {
    const profile = await accountApi.getProfile({ telegramId: ctx.from.id });
    await ctx.reply(formatter.formatProfile(profile), { parse_mode: "HTML" });
  } catch (err) {
    await replyError(ctx, err);
  }
}

async function sendOrderHistory(ctx, page = 1) {
  try {
    const { rows } = await orderApi.listHistory({
      telegramId: ctx.from.id,
      page,
      pageSize: 10,
    });
    if (!rows.length) {
      await ctx.reply("📭 No orders yet.");
      return;
    }
    const text = [
      `<b>📜 Order history (page ${page})</b>`,
      "",
      ...rows.map((row, idx) => `${(page - 1) * 10 + idx + 1}. ${formatter.formatOrderHistoryRow(row)}`),
    ].join("\n\n");
    await ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (err) {
    await replyError(ctx, err);
  }
}

async function sendHelp(ctx) {
  const lines = [
    "<b>📚 Help — SMS Virtual Telegram Bot</b>",
    "",
    "<b>Setup</b>",
    "/setup — set or update your SMS Virtual API key",
    "/profile — show your account profile",
    "",
    "<b>Balance</b>",
    "/balance — show current balance",
    "",
    "<b>Orders</b>",
    "/order — full multi-step order flow",
    "/order <service> <country> [qty] — smart order, e.g. <code>/order whatsapp indonesia 3</code>",
    "/active — list active orders",
    "/history — order history",
    "",
    "<b>Deposits</b>",
    "/deposit — request a deposit",
    "/deposits — deposit history",
    "",
    "<b>Other</b>",
    "/favorites — saved service+country combos",
    "/settings — language, defaults, toggles",
    "/cancel — abort the current flow",
  ];
  if (ctx.isAdmin && config.bot.accessMode === "multi") {
    lines.push("");
    lines.push("<b>Admin (multi mode)</b>");
    lines.push("/users — list users");
    lines.push("/allow <telegram_id> — allow a user");
    lines.push("/disallow <telegram_id> — disallow a user");
  }
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    ...menus.mainMenu(ctx.isAdmin),
  });
}

// ===========================================================================
// Helpers
// ===========================================================================

function stripCommand(text) {
  // "/allow 12345 6789" -> "12345 6789"
  return String(text).replace(/^\/\S+\s*/, "").trim();
}

async function replyError(ctx, err) {
  const friendly =
    err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
  logger.warn("Command failed", {
    err: err && err.message,
    code: err instanceof ApiError ? err.code : null,
  });
  try {
    await ctx.reply(`❌ ${friendly}`);
  } catch (_) {
    /* ignore */
  }
}

module.exports = {
  register,
  dispatchTextDuringFlow,
};
