"use strict";

/**
 * /settings flow.
 *
 * Lets the user toggle / change:
 *   - Default language (en | id)
 *   - Default country (free-text country name; resolved against /v1/public/countries)
 *   - Default order quantity (1..20)
 *   - Auto-search server toggle
 *   - OTP watcher toggle
 *   - API key (delegates to setupFlow)
 *
 * Admin-only extras (multi mode):
 *   - List allowed users
 *   - /allow <telegram_id>, /disallow <telegram_id>
 *
 * Callback prefixes (matching menus.settingsKeyboard):
 *   settings:apikey, settings:country, settings:quantity,
 *   settings:autosearch, settings:otpwatcher, settings:admin,
 *   settings:lang:<en|id>, settings:open
 */

const { Markup } = require("telegraf");

const config = require("../config");
const formatter = require("../utils/formatter");
const validator = require("../utils/validator");
const { settingsRepo, usersRepo } = require("../db/repositories");
const menus = require("../bot/menus");
const setupFlow = require("./setupFlow");
const { isAdmin } = require("../bot/middlewares");

const STAGES = Object.freeze({
  AWAITING_VALUE: "settings:awaiting_value",
});

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

async function showSettings(ctx) {
  const settings = settingsRepo.getOrCreate(ctx.from.id, {
    defaultQuantity: config.order.defaultQuantity,
    autoSearchServer: config.order.autoSearchServer,
    otpWatcherEnabled: config.otpWatcher.enabled,
    language: config.bot.defaultLanguage,
  });
  await replyOrEdit(ctx, buildText(settings), menus.settingsKeyboard(settings));
}

function buildText(settings) {
  return [
    "<b>⚙️ Settings</b>",
    "",
    `<b>Language:</b> ${formatter.escapeHtml(settings.language || "en")}`,
    `<b>Default country:</b> ${formatter.escapeHtml(settings.default_country_name || "—")}`,
    `<b>Default quantity:</b> ${settings.default_quantity || 1}`,
    `<b>Auto-search server:</b> ${settings.auto_search_server ? "ON" : "OFF"}`,
    `<b>OTP watcher:</b> ${settings.otp_watcher_enabled ? "ON" : "OFF"}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Toggles
// ---------------------------------------------------------------------------

async function toggleAutoSearch(ctx) {
  const settings = settingsRepo.getOrCreate(ctx.from.id);
  settingsRepo.update(ctx.from.id, {
    auto_search_server: settings.auto_search_server ? 0 : 1,
  });
  await ctx.answerCbQuery(
    `Auto-search ${settings.auto_search_server ? "OFF" : "ON"}.`
  );
  await showSettings(ctx);
}

async function toggleOtpWatcher(ctx) {
  const settings = settingsRepo.getOrCreate(ctx.from.id);
  settingsRepo.update(ctx.from.id, {
    otp_watcher_enabled: settings.otp_watcher_enabled ? 0 : 1,
  });
  await ctx.answerCbQuery(
    `OTP watcher ${settings.otp_watcher_enabled ? "OFF" : "ON"}.`
  );
  await showSettings(ctx);
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

async function promptLanguage(ctx) {
  await replyOrEdit(
    ctx,
    "<b>🌐 Choose language</b>",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🇬🇧 English", "settings:lang:en"),
        Markup.button.callback("🇮🇩 Indonesia", "settings:lang:id"),
      ],
      [Markup.button.callback("⬅️ Back", "settings:open")],
    ])
  );
}

async function setLanguage(ctx, lang) {
  const next = lang === "id" ? "id" : "en";
  settingsRepo.update(ctx.from.id, { language: next });
  await ctx.answerCbQuery(`Language set to ${next}.`);
  await showSettings(ctx);
}

// ---------------------------------------------------------------------------
// Default country
// ---------------------------------------------------------------------------

async function promptDefaultCountry(ctx) {
  ctx.setStage(STAGES.AWAITING_VALUE, { settingsField: "default_country" });
  await replyOrEdit(
    ctx,
    [
      "<b>🌍 Default country</b>",
      "",
      "Type your default country (e.g. <code>indonesia</code>).",
      "Send <code>-</code> to clear.",
    ].join("\n"),
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "settings:open")]])
  );
}

async function promptDefaultQuantity(ctx) {
  ctx.setStage(STAGES.AWAITING_VALUE, { settingsField: "default_quantity" });
  await replyOrEdit(
    ctx,
    "<b>#️⃣ Default quantity</b>\n\nType a number between 1 and 20.",
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Back", "settings:open")]])
  );
}

function isAwaitingValue(ctx) {
  return ctx.session && ctx.session.stage === STAGES.AWAITING_VALUE;
}

async function handleValueMessage(ctx) {
  const data = ctx.session.data || {};
  const field = data.settingsField;
  const text = (ctx.message && ctx.message.text) || "";
  const trimmed = text.trim();

  if (!field) {
    ctx.clearStage();
    return;
  }

  if (field === "default_country") {
    if (trimmed === "-" || trimmed === "") {
      settingsRepo.update(ctx.from.id, {
        default_country_id: null,
        default_country_name: null,
      });
      await ctx.reply("✅ Default country cleared.");
    } else {
      // Best-effort lookup so we can store both id and label.
      let id = null;
      let name = trimmed;
      try {
        const catalogApi = require("../api/catalogApi");
        const { rows } = await catalogApi.listCountries({
          telegramId: ctx.from.id,
          pageSize: 200,
          search: trimmed,
        });
        const match = rows.find((c) =>
          (c.name || "").toLowerCase().includes(trimmed.toLowerCase())
        );
        if (match) {
          id = match.id;
          name = match.name;
        }
      } catch (_) {
        /* ignore — keep the text as-is */
      }
      settingsRepo.update(ctx.from.id, {
        default_country_id: id,
        default_country_name: name,
      });
      await ctx.reply(`✅ Default country saved: ${formatter.escapeHtml(name)}`, {
        parse_mode: "HTML",
      });
    }
  } else if (field === "default_quantity") {
    if (!validator.isPositiveInt(trimmed, { min: 1, max: 20 })) {
      await ctx.reply("❌ Please send a number between 1 and 20.");
      return;
    }
    settingsRepo.update(ctx.from.id, { default_quantity: Number(trimmed) });
    await ctx.reply(`✅ Default quantity saved: ${trimmed}`);
  } else {
    await ctx.reply("Unknown setting.");
  }

  ctx.clearStage();
  await showSettings(ctx);
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

async function startApiKeyUpdate(ctx) {
  await ctx.answerCbQuery();
  await setupFlow.startSetup(ctx);
}

// ---------------------------------------------------------------------------
// Admin: allowlist (multi-user mode)
// ---------------------------------------------------------------------------

async function listAllowedUsers(ctx) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin only.");
    return;
  }
  const allUsers = usersRepo.listUsers();
  if (!allUsers.length) {
    await ctx.reply(
      "No users yet. Use <code>/allow <telegram_id></code> to add one.",
      { parse_mode: "HTML" }
    );
    return;
  }
  const lines = ["<b>👥 Users</b>", ""];
  allUsers.forEach((u, idx) => {
    const status = u.is_allowed ? "✅" : "🚫";
    const masked = u.api_key_masked ? ` · key: <code>${u.api_key_masked}</code>` : " · no key";
    const label = u.first_name || u.username || String(u.telegram_id);
    lines.push(
      `${idx + 1}. ${status} <code>${u.telegram_id}</code> ${formatter.escapeHtml(label)}${masked}`
    );
  });
  await ctx.reply(lines.join("\n"), {
    parse_mode: "HTML",
    ...menus.adminUsersKeyboard(allUsers),
  });
}

async function toggleAllowedUser(ctx, telegramId) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery("Admin only.", { show_alert: true });
    return;
  }
  const id = Number(telegramId);
  if (!Number.isFinite(id)) {
    await ctx.answerCbQuery("Invalid id.", { show_alert: true });
    return;
  }
  const row = usersRepo.findByTelegramId(id);
  if (!row) {
    await ctx.answerCbQuery("User not found.", { show_alert: true });
    return;
  }
  usersRepo.setAllowed(id, row.is_allowed ? 0 : 1);
  await ctx.answerCbQuery(`User ${id} ${row.is_allowed ? "disallowed" : "allowed"}.`);
  await listAllowedUsers(ctx);
}

async function allowUser(ctx, telegramIdRaw) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin only.");
    return;
  }
  const tid = String(telegramIdRaw || "").replace(/\D/g, "");
  if (!tid) {
    await ctx.reply("Usage: <code>/allow <telegram_id></code>", {
      parse_mode: "HTML",
    });
    return;
  }
  const idNum = Number(tid);
  let row = usersRepo.findByTelegramId(idNum);
  if (!row) {
    row = usersRepo.upsertFromTelegram({ telegramId: idNum });
  }
  usersRepo.setAllowed(idNum, 1);
  await ctx.reply(`✅ User <code>${tid}</code> allowed.`, { parse_mode: "HTML" });
}

async function disallowUser(ctx, telegramIdRaw) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.reply("Admin only.");
    return;
  }
  const tid = String(telegramIdRaw || "").replace(/\D/g, "");
  if (!tid) {
    await ctx.reply("Usage: <code>/disallow <telegram_id></code>", {
      parse_mode: "HTML",
    });
    return;
  }
  usersRepo.setAllowed(Number(tid), 0);
  await ctx.reply(`✅ User <code>${tid}</code> disallowed.`, { parse_mode: "HTML" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function replyOrEdit(ctx, text, keyboard, extra = {}) {
  const opts = {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? keyboard : {}),
    ...extra,
  };
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch (_) {
      /* fall through */
    }
  }
  await ctx.reply(text, opts);
}

module.exports = {
  STAGES,
  showSettings,
  toggleAutoSearch,
  toggleOtpWatcher,
  promptLanguage,
  setLanguage,
  promptDefaultCountry,
  promptDefaultQuantity,
  handleValueMessage,
  isAwaitingValue,
  startApiKeyUpdate,
  listAllowedUsers,
  toggleAllowedUser,
  allowUser,
  disallowUser,
};
