"use strict";

/**
 * Active orders flow.
 *
 * Renders the user's ongoing activations (from
 * `GET /v1/public/orders/ongoing-activation`) and exposes the per-order
 * action buttons via `menus.orderActionsKeyboard`:
 *
 *   - 🔎 Check OTP / refresh status   (callback: order:check:<activationId>)
 *   - ✅ Mark Ready                    (callback: order:ready:<activationId>)
 *   - 🔁 Resend SMS                    (callback: order:resend:<activationId>)
 *   - ❌ Cancel                        (callback: order:cancel:<activationId>)
 *   - 🏁 Complete                      (callback: order:complete:<activationId>)
 *   - ⭐ Save Favorite                 (callback: order:fav:<activationId>)
 *
 * The activation id may contain URL-unsafe characters; we encodeURIComponent
 * when emitting and decodeURIComponent when receiving (handled by callbacks.js).
 */

const { Markup } = require("telegraf");

const logger = require("../utils/logger");
const formatter = require("../utils/formatter");
const sanitizer = require("../utils/sanitizer");
const orderApi = require("../api/orderApi");
const accountApi = require("../api/accountApi");
const { ordersRepo, favoritesRepo } = require("../db/repositories");
const menus = require("../bot/menus");
const { ApiError, toFriendlyMessage } = require("../utils/errors");

const PAGE_SIZE = 6;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

async function fetchActiveList(telegramId) {
  const { rows } = await orderApi.listOngoingActivation({ telegramId });
  for (const row of rows) {
    try {
      ordersRepo.upsertFromActivation(telegramId, row);
    } catch (err) {
      logger.warn("activeOrderFlow.persist_failed", { err: err.message });
    }
  }
  return rows;
}

function setListCache(ctx, rows, page = 0) {
  ctx.session.data = ctx.session.data || {};
  ctx.session.data.activeList = {
    rows,
    page,
    fetchedAt: Date.now(),
  };
}

function getListCache(ctx) {
  return ctx.session && ctx.session.data && ctx.session.data.activeList
    ? ctx.session.data.activeList
    : null;
}

function buildListKeyboard(rows, page) {
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const buttons = slice.map((row, idx) => {
    const phone = sanitizer.maskPhoneNumber(row.phoneNumber || "—");
    const label = `${safePage * PAGE_SIZE + idx + 1}. ${phone}`.slice(0, 48);
    const id = encodeURIComponent(String(row.id || row.activationId || ""));
    return [Markup.button.callback(label, `order:open:${id}`)];
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback("⬅️ Prev", `order:list:page:${safePage - 1}`));
  nav.push(Markup.button.callback(`Page ${safePage + 1}/${totalPages}`, "order:list:noop"));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback("Next ➡️", `order:list:page:${safePage + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([
    Markup.button.callback("🔄 Refresh", "order:list:refresh"),
    Markup.button.callback("❌ Close", "order:list:close"),
  ]);

  return Markup.inlineKeyboard(buttons);
}

function buildListText(rows, page) {
  if (!rows.length) {
    return "<b>📭 No active orders</b>\n\nUse /order or 🌍 Order Number to request a new number.";
  }
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = rows.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const items = slice.map((row, idx) => {
    const n = safePage * PAGE_SIZE + idx + 1;
    return `${n}. ${formatter.formatActivationRow(row)}`;
  });
  return ["<b>📦 Active Orders</b>", "", ...items].join("\n\n");
}

async function listActive(ctx) {
  try {
    const rows = await fetchActiveList(ctx.from.id);
    setListCache(ctx, rows, 0);
    await replyOrEdit(ctx, buildListText(rows, 0), buildListKeyboard(rows, 0));
  } catch (err) {
    await replyOrEdit(ctx, `❌ ${formatter.escapeHtml(toFriendlyMessage(err))}`);
  }
}

async function handlePage(ctx, page) {
  const cache = getListCache(ctx);
  if (!cache) return listActive(ctx);
  cache.page = page;
  setListCache(ctx, cache.rows, page);
  await replyOrEdit(ctx, buildListText(cache.rows, page), buildListKeyboard(cache.rows, page));
}

async function refreshList(ctx) {
  await listActive(ctx);
}

async function closeList(ctx) {
  if (ctx.callbackQuery && ctx.callbackQuery.message) {
    try {
      await ctx.deleteMessage();
      return;
    } catch (_) {
      // ignore — message may be too old
    }
  }
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function buildDetailText(activation) {
  const lines = [
    "<b>📱 Order Detail</b>",
    "",
    formatter.formatOrderSummary(
      {
        serviceName:
          (activation.serviceCountry &&
            activation.serviceCountry.service &&
            activation.serviceCountry.service.name) ||
          activation.serviceName ||
          null,
        countryName:
          (activation.serviceCountry &&
            activation.serviceCountry.country &&
            activation.serviceCountry.country.name) ||
          activation.countryName ||
          null,
        operatorName:
          (activation.operator && activation.operator.name) ||
          activation.operatorName ||
          null,
        phoneNumber: activation.phoneNumber,
        amount: activation.servicePrice ?? activation.amount,
        status: activation.status,
        expiredTime: activation.expiredTime,
      },
      { maskPhone: false }
    ),
  ];
  const otp = activation.otp || activation.code || activation.last_otp;
  if (otp) {
    lines.push("");
    lines.push(`<b>OTP:</b> <code>${formatter.escapeHtml(otp)}</code>`);
  }
  return lines.join("\n");
}

async function findActivation(ctx, activationId) {
  const cache = getListCache(ctx);
  if (cache) {
    const hit = cache.rows.find(
      (r) => String(r.id || r.activationId) === String(activationId)
    );
    if (hit) return hit;
  }
  try {
    const fresh = await orderApi.getStatus({
      telegramId: ctx.from.id,
      id: activationId,
    });
    if (fresh && typeof fresh === "object") return fresh;
    if (typeof fresh === "string") {
      // getStatus may simply return the OTP text; fall back to local row.
      const local = ordersRepo.findByActivationId(ctx.from.id, activationId);
      if (local) {
        return {
          id: activationId,
          phoneNumber: local.phone_number,
          serviceName: local.service_name,
          countryName: local.country_name,
          operatorName: local.operator_name,
          status: local.status,
          otp: fresh,
          servicePrice: local.price,
        };
      }
    }
  } catch (_) {
    /* ignore — we'll try the local store */
  }
  const local = ordersRepo.findByActivationId(ctx.from.id, activationId);
  if (local) {
    return {
      id: activationId,
      phoneNumber: local.phone_number,
      serviceName: local.service_name,
      countryName: local.country_name,
      operatorName: local.operator_name,
      status: local.status,
      otp: local.last_otp,
      servicePrice: local.price,
    };
  }
  return null;
}

async function openDetail(ctx, activationId) {
  const row = await findActivation(ctx, activationId);
  if (!row) {
    await ctx.answerCbQuery("Activation not found.", { show_alert: true });
    return;
  }
  await replyOrEdit(
    ctx,
    buildDetailText(row),
    menus.orderActionsKeyboard({ activationId: row.id || activationId })
  );
}

// ---------------------------------------------------------------------------
// Per-activation actions
// ---------------------------------------------------------------------------

async function checkOtp(ctx, activationId) {
  try {
    const data = await orderApi.getStatus({
      telegramId: ctx.from.id,
      id: activationId,
    });

    let otpText = null;
    let activation = null;
    if (typeof data === "string") {
      otpText = data;
    } else if (data && typeof data === "object") {
      activation = data;
      otpText = data.otp || data.code || null;
    }

    const local = ordersRepo.findByActivationId(ctx.from.id, activationId);
    if (otpText && local) {
      ordersRepo.setOtp(local.id, otpText, true);
    }
    if (activation) {
      try {
        ordersRepo.upsertFromActivation(ctx.from.id, {
          ...activation,
          id: activation.id || activationId,
        });
      } catch (_) {
        /* ignore */
      }
    }

    if (otpText) {
      await ctx.answerCbQuery("OTP received.");
      const order = local || (await findActivation(ctx, activationId));
      await ctx.reply(
        formatter.formatOtpNotification(
          {
            phoneNumber: order && (order.phoneNumber || order.phone_number),
            serviceName: order && (order.serviceName || order.service_name),
            countryName: order && (order.countryName || order.country_name),
          },
          otpText
        ),
        { parse_mode: "HTML" }
      );
    } else {
      await ctx.answerCbQuery("No OTP yet. Try again in a few seconds.");
    }
  } catch (err) {
    await answerError(ctx, err);
  }
}

async function markReady(ctx, activationId) {
  await runActivationAction(ctx, activationId, "ready");
}

async function resend(ctx, activationId) {
  await runActivationAction(ctx, activationId, "resend");
}

async function cancel(ctx, activationId) {
  await runActivationAction(ctx, activationId, "cancel");
}

async function complete(ctx, activationId) {
  await runActivationAction(ctx, activationId, "complete");
}

async function runActivationAction(ctx, activationId, action) {
  try {
    let payload;
    switch (action) {
      case "ready":
        payload = await orderApi.markReady({ telegramId: ctx.from.id, id: activationId });
        break;
      case "resend":
        payload = await orderApi.resend({ telegramId: ctx.from.id, id: activationId });
        break;
      case "cancel":
        payload = await orderApi.cancel({ telegramId: ctx.from.id, id: activationId });
        break;
      case "complete":
        payload = await orderApi.complete({ telegramId: ctx.from.id, id: activationId });
        break;
      default:
        return;
    }
    await ctx.answerCbQuery(`✅ ${action[0].toUpperCase()}${action.slice(1)} done.`);

    // Refresh the row so the user sees authoritative status.
    let fresh = null;
    try {
      const data = await orderApi.getStatus({ telegramId: ctx.from.id, id: activationId });
      if (data && typeof data === "object") fresh = data;
    } catch (_) {
      /* ignore */
    }
    if (fresh) {
      try { ordersRepo.upsertFromActivation(ctx.from.id, { ...fresh, id: fresh.id || activationId }); } catch (_) { /* ignore */ }
      await replyOrEdit(
        ctx,
        buildDetailText(fresh),
        menus.orderActionsKeyboard({ activationId: fresh.id || activationId })
      );
    }

    if (action === "cancel" || action === "complete") {
      try {
        const balance = await accountApi.getBalance({ telegramId: ctx.from.id });
        if (balance !== null) {
          await ctx.reply(formatter.formatBalance(balance), { parse_mode: "HTML" });
        }
      } catch (_) {
        /* ignore */
      }
    }
  } catch (err) {
    await answerError(ctx, err);
  }
}

// ---------------------------------------------------------------------------
// Save current activation as a favorite
// ---------------------------------------------------------------------------

async function saveAsFavorite(ctx, activationId) {
  const local = ordersRepo.findByActivationId(ctx.from.id, activationId);
  if (!local) {
    await ctx.answerCbQuery("Cannot read order info.", { show_alert: true });
    return;
  }
  let raw = null;
  try {
    raw = local.raw_json ? JSON.parse(local.raw_json) : null;
  } catch (_) {
    raw = null;
  }

  const countryId =
    (raw && raw.serviceCountry && raw.serviceCountry.country && raw.serviceCountry.country.id) ||
    null;
  const serviceId =
    (raw && raw.serviceCountry && raw.serviceCountry.service && raw.serviceCountry.service.id) ||
    null;
  const operatorId = raw && raw.operator ? raw.operator.id : null;
  const serviceCountryPriceId =
    (raw && raw.serviceCountry && raw.serviceCountry.id) || null;

  if (!countryId || !serviceId) {
    await ctx.answerCbQuery("Missing service/country to save.", { show_alert: true });
    return;
  }

  favoritesRepo.add(ctx.from.id, {
    name: `${local.service_name || "service"} · ${local.country_name || "country"}`,
    countryId,
    countryName: local.country_name,
    serviceId,
    serviceName: local.service_name,
    serviceCountryPriceId,
    operatorId,
    operatorName: local.operator_name,
    quantity: 1,
    autoSearchServer: true,
  });
  await ctx.answerCbQuery("⭐ Saved to favorites.");
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
      /* fall through to reply */
    }
  }
  await ctx.reply(text, opts);
}

async function answerError(ctx, err) {
  const msg = err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
  try {
    await ctx.answerCbQuery(msg, { show_alert: true });
  } catch (_) {
    await ctx.reply(`❌ ${msg}`);
  }
}

module.exports = {
  listActive,
  handlePage,
  refreshList,
  closeList,
  openDetail,
  checkOtp,
  markReady,
  resend,
  cancel,
  complete,
  saveAsFavorite,
};
