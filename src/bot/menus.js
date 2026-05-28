"use strict";

/**
 * Reusable inline keyboards.
 *
 * The bot's main entry point is the persistent reply keyboard (`mainMenu`).
 * Multi-step flows use inline keyboards with callback data of the form:
 *   <namespace>:<action>:<id>?
 */

const { Markup } = require("telegraf");

function mainMenu(isAdmin = false) {
  const rows = [
    ["💰 Balance", "🌍 Order Number"],
    ["📦 Active Orders", "📜 Order History"],
    ["💳 Deposit", "⭐ Favorites"],
    ["⚙️ Settings", "❓ Help"],
  ];
  if (isAdmin) {
    rows.push(["👥 Admin: Users"]);
  }
  return Markup.keyboard(rows).resize().persistent();
}

function setupKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔑 Set / Update API Key", "setup:start")],
    [Markup.button.callback("ℹ️ How to get an API key", "setup:help")],
  ]);
}

function backCancelRow({ cancelLabel = "❌ Cancel", cancelData = "flow:cancel", backData } = {}) {
  const row = [];
  if (backData) {
    row.push(Markup.button.callback("⬅️ Back", backData));
  }
  row.push(Markup.button.callback(cancelLabel, cancelData));
  return row;
}

function paginatedList({
  items,
  formatRow,
  pageIndex = 0,
  pageSize = 8,
  rowAction, // (item) => callback_data string
  prevAction,
  nextAction,
  extraRows = [],
  cancelData = "flow:cancel",
}) {
  const start = pageIndex * pageSize;
  const slice = items.slice(start, start + pageSize);

  const rows = slice.map((item) => [
    Markup.button.callback(formatRow(item), rowAction(item)),
  ]);

  const controls = [];
  if (pageIndex > 0 && prevAction) {
    controls.push(Markup.button.callback("⬅️ Prev", prevAction));
  }
  if (start + pageSize < items.length && nextAction) {
    controls.push(Markup.button.callback("Next ➡️", nextAction));
  }
  if (controls.length) rows.push(controls);

  if (Array.isArray(extraRows) && extraRows.length) {
    for (const r of extraRows) rows.push(r);
  }

  rows.push([Markup.button.callback("❌ Cancel", cancelData)]);

  return Markup.inlineKeyboard(rows);
}

function confirmKeyboard({ confirmData, cancelData = "flow:cancel", confirmLabel = "✅ Confirm" }) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(confirmLabel, confirmData),
      Markup.button.callback("❌ Cancel", cancelData),
    ],
  ]);
}

function orderActionsKeyboard({ activationId }) {
  const id = encodeURIComponent(String(activationId));
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🔎 Check OTP", `order:check:${id}`),
      Markup.button.callback("✅ Mark Ready", `order:ready:${id}`),
    ],
    [
      Markup.button.callback("🔁 Resend OTP", `order:resend:${id}`),
      Markup.button.callback("❌ Cancel", `order:cancel:${id}`),
    ],
    [Markup.button.callback("🏁 Complete", `order:complete:${id}`)],
    [Markup.button.callback("⭐ Save as Favorite", `order:fav:${id}`)],
  ]);
}

function depositActionsKeyboard({ depositId }) {
  const id = encodeURIComponent(String(depositId));
  return Markup.inlineKeyboard([
    [Markup.button.callback("📜 Deposit history", "deposit:history")],
    [Markup.button.callback("❌ Cancel deposit", `deposit:cancel:${id}`)],
  ]);
}

function favoritesListKeyboard(favorites) {
  const rows = favorites.map((fav) => [
    Markup.button.callback(
      `⚡ ${truncate(fav.name || `${fav.service_name} · ${fav.country_name}`, 40)}`,
      `fav:run:${fav.id}`
    ),
    Markup.button.callback("🗑", `fav:del:${fav.id}`),
  ]);
  rows.push([Markup.button.callback("⬅️ Back to menu", "flow:cancel")]);
  return Markup.inlineKeyboard(rows);
}

function settingsKeyboard(settings) {
  const auto = settings.auto_search_server ? "✅" : "⚪";
  const watcher = settings.otp_watcher_enabled ? "✅" : "⚪";
  const qty = settings.default_quantity || 1;
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔑 Update API key", "settings:apikey")],
    [Markup.button.callback("🌍 Default country", "settings:country")],
    [Markup.button.callback(`#️⃣ Default quantity (${qty})`, "settings:quantity")],
    [Markup.button.callback(`${auto} Auto search server`, "settings:autosearch")],
    [Markup.button.callback(`${watcher} OTP watcher`, "settings:otpwatcher")],
    [Markup.button.callback("👥 Admin: users (multi mode)", "settings:admin")],
    [Markup.button.callback("⬅️ Back", "flow:cancel")],
  ]);
}

function adminUsersKeyboard(users) {
  const rows = users.map((u) => {
    const allowed = u.is_allowed ? "✅" : "🚫";
    const label = `${allowed} ${u.first_name || u.username || u.telegram_id}`;
    return [Markup.button.callback(truncate(label, 40), `admin:toggle:${u.telegram_id}`)];
  });
  rows.push([Markup.button.callback("⬅️ Back", "flow:cancel")]);
  return Markup.inlineKeyboard(rows);
}

function truncate(value, max) {
  const s = String(value || "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

module.exports = {
  mainMenu,
  setupKeyboard,
  backCancelRow,
  paginatedList,
  confirmKeyboard,
  orderActionsKeyboard,
  depositActionsKeyboard,
  favoritesListKeyboard,
  settingsKeyboard,
  adminUsersKeyboard,
  truncate,
};
