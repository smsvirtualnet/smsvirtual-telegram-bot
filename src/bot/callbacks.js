"use strict";

/**
 * Inline-keyboard callback dispatcher.
 *
 * Patterns recognized (matching what menus.js + flows emit):
 *
 *   flow:cancel
 *
 *   setup:start | setup:help
 *
 *   order:country:pick:<id>      | order:country:prev | order:country:next
 *   order:country:search         | order:country:reset
 *   order:service:pick:<id>      | order:service:prev | order:service:next
 *   order:service:search         | order:service:reset
 *   order:price:pick:<id>
 *   order:op:pick:<id|"any">
 *   order:qty:pick:<n>           | order:qty:type
 *   order:back:<step>            | order:toggle:autosearch
 *   order:confirm
 *
 *   order:open:<id>              order:check:<id>
 *   order:ready:<id>             order:resend:<id>
 *   order:cancel:<id>            order:complete:<id>
 *   order:fav:<id>
 *   order:list:page:<n> | order:list:refresh | order:list:close | order:list:noop
 *
 *   deposit:methodpage:<n> | deposit:pick:<idx> | deposit:submit
 *   deposit:cancel:<id>    | deposit:history    | deposit:noop
 *
 *   fav:run:<id> | fav:del:<id>
 *
 *   settings:open | settings:apikey | settings:country | settings:quantity
 *   settings:autosearch | settings:otpwatcher | settings:admin
 *   settings:lang:<en|id>
 *
 *   admin:toggle:<telegram_id>
 *
 * Each handler is wrapped so a misbehaving handler always answers the
 * callback query (otherwise the Telegram client shows an endless spinner).
 */

const logger = require("../utils/logger");
const formatter = require("../utils/formatter");
const { ApiError, toFriendlyMessage } = require("../utils/errors");

const setupFlow = require("../flows/setupFlow");
const orderFlow = require("../flows/orderFlow");
const activeOrderFlow = require("../flows/activeOrderFlow");
const depositFlow = require("../flows/depositFlow");
const favoriteFlow = require("../flows/favoriteFlow");
const settingsFlow = require("../flows/settingsFlow");
const menus = require("./menus");

function register(bot) {
  bot.on("callback_query", async (ctx) => {
    const data = (ctx.callbackQuery && ctx.callbackQuery.data) || "";
    if (!data) return ack(ctx);

    try {
      await dispatch(ctx, data);
    } catch (err) {
      logger.warn("callback_query handler failed", {
        data,
        err: err && err.message,
        code: err instanceof ApiError ? err.code : null,
      });
      const friendly =
        err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
      try {
        await ctx.answerCbQuery(friendly, { show_alert: true });
      } catch (_) {
        try {
          await ctx.reply(`⚠️ ${formatter.escapeHtml(friendly)}`, {
            parse_mode: "HTML",
          });
        } catch (__) {
          /* ignore */
        }
      }
    }
  });
}

async function dispatch(ctx, data) {
  // -------------------------------------------------------------------------
  // Generic
  // -------------------------------------------------------------------------
  if (data === "flow:cancel") {
    ctx.clearStage();
    await ctx.answerCbQuery("Cancelled.");
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (_) {
      /* ignore */
    }
    return;
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------
  if (data === "setup:start") {
    await ack(ctx);
    return setupFlow.startSetup(ctx);
  }
  if (data === "setup:help") {
    await ack(ctx);
    return setupFlow.showHelp(ctx);
  }

  // -------------------------------------------------------------------------
  // Order flow — pickers
  // -------------------------------------------------------------------------
  if (data.startsWith("order:country:")) {
    return handleOrderCountry(ctx, data);
  }
  if (data.startsWith("order:service:")) {
    return handleOrderService(ctx, data);
  }
  if (data.startsWith("order:price:pick:")) {
    await ack(ctx);
    const id = data.slice("order:price:pick:".length);
    return orderFlow.pickPriceById(ctx, id);
  }
  if (data.startsWith("order:op:pick:")) {
    await ack(ctx);
    const id = data.slice("order:op:pick:".length);
    return orderFlow.pickOperatorById(ctx, id);
  }
  if (data.startsWith("order:qty:pick:")) {
    await ack(ctx);
    const n = data.slice("order:qty:pick:".length);
    return orderFlow.setQuantity(ctx, n);
  }
  if (data === "order:qty:type") {
    await ack(ctx);
    return orderFlow.promptTypeQuantity(ctx);
  }
  if (data === "order:toggle:autosearch") {
    if (ctx.session && ctx.session.data) {
      ctx.session.data.autoSearchServer = !ctx.session.data.autoSearchServer;
    }
    await ack(ctx, "Toggled.");
    return orderFlow.renderConfirmStep(ctx);
  }
  if (data.startsWith("order:back:")) {
    return handleOrderBack(ctx, data.slice("order:back:".length));
  }
  if (data === "order:confirm") {
    await ack(ctx, "Placing order …");
    return orderFlow.placeOrder(ctx);
  }

  // -------------------------------------------------------------------------
  // Order flow — active list / per-activation actions
  // -------------------------------------------------------------------------
  if (data === "order:list:noop") return ack(ctx);
  if (data === "order:list:refresh") {
    await ack(ctx, "Refreshing …");
    return activeOrderFlow.refreshList(ctx);
  }
  if (data === "order:list:close") {
    await ack(ctx);
    return activeOrderFlow.closeList(ctx);
  }
  if (data.startsWith("order:list:page:")) {
    await ack(ctx);
    const page = Number(data.slice("order:list:page:".length));
    return activeOrderFlow.handlePage(ctx, Number.isFinite(page) ? page : 0);
  }
  if (data.startsWith("order:open:")) {
    await ack(ctx);
    const id = decodeURIComponent(data.slice("order:open:".length));
    return activeOrderFlow.openDetail(ctx, id);
  }
  if (data.startsWith("order:check:")) {
    const id = decodeURIComponent(data.slice("order:check:".length));
    return activeOrderFlow.checkOtp(ctx, id);
  }
  if (data.startsWith("order:ready:")) {
    const id = decodeURIComponent(data.slice("order:ready:".length));
    return activeOrderFlow.markReady(ctx, id);
  }
  if (data.startsWith("order:resend:")) {
    const id = decodeURIComponent(data.slice("order:resend:".length));
    return activeOrderFlow.resend(ctx, id);
  }
  if (data.startsWith("order:cancel:")) {
    const id = decodeURIComponent(data.slice("order:cancel:".length));
    return activeOrderFlow.cancel(ctx, id);
  }
  if (data.startsWith("order:complete:")) {
    const id = decodeURIComponent(data.slice("order:complete:".length));
    return activeOrderFlow.complete(ctx, id);
  }
  if (data.startsWith("order:fav:")) {
    const id = decodeURIComponent(data.slice("order:fav:".length));
    return activeOrderFlow.saveAsFavorite(ctx, id);
  }

  // -------------------------------------------------------------------------
  // Deposit flow
  // -------------------------------------------------------------------------
  if (data === "deposit:noop") return ack(ctx);
  if (data === "deposit:history") {
    await ack(ctx);
    return depositFlow.showHistory(ctx, 1);
  }
  if (data === "deposit:submit") {
    return depositFlow.submitDeposit(ctx);
  }
  if (data.startsWith("deposit:methodpage:")) {
    await ack(ctx);
    const page = Number(data.slice("deposit:methodpage:".length));
    return depositFlow.handleMethodPage(ctx, Number.isFinite(page) ? page : 0);
  }
  if (data.startsWith("deposit:pick:")) {
    await ack(ctx);
    const idx = Number(data.slice("deposit:pick:".length));
    return depositFlow.pickMethodIndex(ctx, idx);
  }
  if (data.startsWith("deposit:cancel:")) {
    const id = decodeURIComponent(data.slice("deposit:cancel:".length));
    return depositFlow.cancelDepositById(ctx, id);
  }

  // -------------------------------------------------------------------------
  // Favorites
  // -------------------------------------------------------------------------
  if (data.startsWith("fav:run:")) {
    const id = Number(data.slice("fav:run:".length));
    return favoriteFlow.runFavorite(ctx, id);
  }
  if (data.startsWith("fav:del:")) {
    const id = Number(data.slice("fav:del:".length));
    return favoriteFlow.deleteFavorite(ctx, id);
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------
  if (data === "settings:open") {
    await ack(ctx);
    return settingsFlow.showSettings(ctx);
  }
  if (data === "settings:apikey") {
    return settingsFlow.startApiKeyUpdate(ctx);
  }
  if (data === "settings:country") {
    await ack(ctx);
    return settingsFlow.promptDefaultCountry(ctx);
  }
  if (data === "settings:quantity") {
    await ack(ctx);
    return settingsFlow.promptDefaultQuantity(ctx);
  }
  if (data === "settings:autosearch") {
    return settingsFlow.toggleAutoSearch(ctx);
  }
  if (data === "settings:otpwatcher") {
    return settingsFlow.toggleOtpWatcher(ctx);
  }
  if (data === "settings:admin") {
    await ack(ctx);
    return settingsFlow.listAllowedUsers(ctx);
  }
  if (data.startsWith("settings:lang:")) {
    const lang = data.slice("settings:lang:".length);
    return settingsFlow.setLanguage(ctx, lang);
  }

  // -------------------------------------------------------------------------
  // Admin
  // -------------------------------------------------------------------------
  if (data.startsWith("admin:toggle:")) {
    const tid = data.slice("admin:toggle:".length);
    return settingsFlow.toggleAllowedUser(ctx, tid);
  }

  // Fallback.
  await ack(ctx);
  logger.warn("Unknown callback_query data", { data });
}

// ---------------------------------------------------------------------------
// Order — country / service sub-routers
// ---------------------------------------------------------------------------

async function handleOrderCountry(ctx, data) {
  const tail = data.slice("order:country:".length);
  if (tail.startsWith("pick:")) {
    await ack(ctx);
    return orderFlow.pickCountryById(ctx, tail.slice("pick:".length));
  }
  const sess = ctx.session && ctx.session.data;
  if (!sess) {
    await ack(ctx);
    return orderFlow.startOrder(ctx);
  }
  if (tail === "prev") {
    sess.countryPage = Math.max(0, (sess.countryPage || 0) - 1);
    await ack(ctx);
    return orderFlow.renderCountryStep(ctx);
  }
  if (tail === "next") {
    sess.countryPage = (sess.countryPage || 0) + 1;
    await ack(ctx);
    return orderFlow.renderCountryStep(ctx);
  }
  if (tail === "search") {
    await ack(ctx);
    return orderFlow.promptSearchCountry(ctx);
  }
  if (tail === "reset") {
    sess.countrySearch = "";
    sess.countryPage = 0;
    await ack(ctx);
    return orderFlow.renderCountryStep(ctx);
  }
  await ack(ctx);
}

async function handleOrderService(ctx, data) {
  const tail = data.slice("order:service:".length);
  if (tail.startsWith("pick:")) {
    await ack(ctx);
    return orderFlow.pickServiceById(ctx, tail.slice("pick:".length));
  }
  const sess = ctx.session && ctx.session.data;
  if (!sess) {
    await ack(ctx);
    return orderFlow.startOrder(ctx);
  }
  if (tail === "prev") {
    sess.servicePage = Math.max(0, (sess.servicePage || 0) - 1);
    await ack(ctx);
    return orderFlow.renderServiceStep(ctx);
  }
  if (tail === "next") {
    sess.servicePage = (sess.servicePage || 0) + 1;
    await ack(ctx);
    return orderFlow.renderServiceStep(ctx);
  }
  if (tail === "search") {
    await ack(ctx);
    return orderFlow.promptSearchService(ctx);
  }
  if (tail === "reset") {
    sess.serviceSearch = "";
    sess.servicePage = 0;
    await ack(ctx);
    return orderFlow.renderServiceStep(ctx);
  }
  await ack(ctx);
}

async function handleOrderBack(ctx, target) {
  const sess = ctx.session && ctx.session.data;
  if (!sess) {
    await ack(ctx);
    return orderFlow.startOrder(ctx);
  }
  await ack(ctx);
  switch (target) {
    case "country":
      return orderFlow.renderCountryStep(ctx);
    case "service":
      return orderFlow.renderServiceStep(ctx);
    case "price":
      return orderFlow.renderPriceStep(ctx);
    case "operator":
      return orderFlow.renderOperatorStep(ctx);
    case "quantity":
      return orderFlow.renderQuantityStep(ctx);
    default:
      return orderFlow.startOrder(ctx);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ack(ctx, text) {
  try {
    if (text) {
      await ctx.answerCbQuery(text);
    } else {
      await ctx.answerCbQuery();
    }
  } catch (_) {
    /* ignore stale callbacks */
  }
}

module.exports = {
  register,
};
