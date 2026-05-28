"use strict";

/**
 * /favorites flow.
 *
 * Lists saved favorites and lets the user re-run them with one tap.
 * Uses callback prefixes emitted by `menus.favoritesListKeyboard`:
 *   - fav:run:<id>  -> hand off to orderFlow.startSmartOrder using stored params
 *   - fav:del:<id>  -> remove the favorite
 *   - flow:cancel   -> close the panel
 */

const formatter = require("../utils/formatter");
const { favoritesRepo } = require("../db/repositories");
const menus = require("../bot/menus");
const orderFlow = require("./orderFlow");
const catalogApi = require("../api/catalogApi");
const { Markup } = require("telegraf");
const { ApiError, toFriendlyMessage } = require("../utils/errors");

async function showFavorites(ctx) {
  const favorites = favoritesRepo.list(ctx.from.id);
  await replyOrEdit(ctx, buildText(favorites), menus.favoritesListKeyboard(favorites));
}

function buildText(favorites) {
  if (!favorites.length) {
    return [
      "<b>⭐ Favorites</b>",
      "",
      "You have no saved favorites yet.",
      "Save one from a confirmed order or from an active-order detail view.",
    ].join("\n");
  }
  const lines = ["<b>⭐ Favorites</b>", ""];
  favorites.forEach((fav, idx) => {
    const label = fav.name || `${fav.service_name || "service"} · ${fav.country_name || "country"}`;
    lines.push(`${idx + 1}. <b>${formatter.escapeHtml(label)}</b>`);
    lines.push(
      `   qty <b>${fav.quantity || 1}</b> · auto-search ${
        fav.auto_search_server ? "ON" : "OFF"
      }`
    );
  });
  return lines.join("\n");
}

async function deleteFavorite(ctx, favId) {
  const fav = favoritesRepo.findById(ctx.from.id, favId);
  if (!fav) {
    await ctx.answerCbQuery("Favorite not found.", { show_alert: true });
    return;
  }
  favoritesRepo.remove(ctx.from.id, favId);
  await ctx.answerCbQuery("Favorite removed.");
  await showFavorites(ctx);
}

async function runFavorite(ctx, favId) {
  const fav = favoritesRepo.findById(ctx.from.id, favId);
  if (!fav) {
    await ctx.answerCbQuery("Favorite not found.", { show_alert: true });
    return;
  }
  await ctx.answerCbQuery();

  // Re-fetch service+country to get fresh `prices[]` so the order flow can
  // resolve the cheapest tier.
  try {
    if (!fav.service_name || !fav.country_name) {
      await ctx.reply("This favorite is missing service/country labels.");
      return;
    }
    await orderFlow.startSmartOrder(ctx, {
      service: fav.service_name,
      country: fav.country_name,
      quantity: fav.quantity || 1,
    });
  } catch (err) {
    const msg = err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
    await ctx.reply(`❌ ${formatter.escapeHtml(msg)}`, { parse_mode: "HTML" });
  }
}

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
  showFavorites,
  deleteFavorite,
  runFavorite,
};
