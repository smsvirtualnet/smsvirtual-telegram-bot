"use strict";

/**
 * /order flow — full multi-step ordering of an SMS activation number.
 *
 * Stages:
 *   order:country         — pick or search country
 *   order:service         — pick or search service for that country
 *   order:price           — pick price tier from `prices[]`
 *   order:operator        — pick operator (or "Any operator")
 *   order:quantity        — type quantity (1-20)
 *   order:confirm         — review summary, confirm
 *
 * Smart command:
 *   /order whatsapp indonesia 3
 * jumps directly to "order:confirm" (after picking the cheapest price tier
 * automatically) and asks for confirmation.
 */

const config = require("../config");
const logger = require("../utils/logger");
const validator = require("../utils/validator");
const formatter = require("../utils/formatter");
const catalogApi = require("../api/catalogApi");
const orderApi = require("../api/orderApi");
const accountApi = require("../api/accountApi");
const { ApiError } = require("../utils/errors");
const { ordersRepo, settingsRepo, favoritesRepo } = require("../db/repositories");
const { Markup } = require("telegraf");
const menus = require("../bot/menus");

const STAGES = Object.freeze({
  COUNTRY: "order:country",
  SERVICE: "order:service",
  PRICE: "order:price",
  OPERATOR: "order:operator",
  QUANTITY: "order:quantity",
  CONFIRM: "order:confirm",
});

const PAGE_SIZE = 8;

// ---------------------------------------------------------------------------
// Entry: /order or "🌍 Order Number"
// ---------------------------------------------------------------------------

async function startOrder(ctx) {
  const settings = settingsRepo.getOrCreate(ctx.from.id);

  ctx.setStage(STAGES.COUNTRY, {
    quantity: settings.default_quantity || config.order.defaultQuantity,
    autoSearchServer:
      settings.auto_search_server === undefined
        ? config.order.autoSearchServer
        : !!settings.auto_search_server,
    countrySearch: "",
    countryPage: 0,
    serviceSearch: "",
    servicePage: 0,
  });

  await renderCountryStep(ctx, { firstRender: true });
}

// ---------------------------------------------------------------------------
// Country step
// ---------------------------------------------------------------------------

async function renderCountryStep(ctx, { firstRender = false } = {}) {
  const data = ctx.session.data;
  const { rows, count } = await catalogApi.listCountries({
    telegramId: ctx.from.id,
    page: 1,
    pageSize: 200,
    search: data.countrySearch || undefined,
  });

  if (!rows.length) {
    await replyOrEdit(
      ctx,
      "No countries match that search. Type a different keyword or /cancel.",
      menus.confirmKeyboard({
        confirmData: "order:country:reset",
        confirmLabel: "🔄 Reset search",
        cancelData: "flow:cancel",
      })
    );
    return;
  }

  const keyboard = menus.paginatedList({
    items: rows,
    pageIndex: data.countryPage || 0,
    pageSize: PAGE_SIZE,
    formatRow: (c) => `${c.name} · code ${c.code}`,
    rowAction: (c) => `order:country:pick:${c.id}`,
    prevAction: "order:country:prev",
    nextAction: "order:country:next",
    extraRows: [
      [
        Markup.button.callback("🔍 Search", "order:country:search"),
        Markup.button.callback("🔄 Clear search", "order:country:reset"),
      ],
    ],
  });

  const intro = firstRender
    ? "🌍 <b>Step 1/5 · Select country</b>\nTap to choose, or use 🔍 Search to filter by name."
    : "🌍 <b>Step 1/5 · Select country</b>";

  const text =
    `${intro}\n` +
    (data.countrySearch ? `\nSearch: <code>${formatter.escapeHtml(data.countrySearch)}</code>` : "") +
    `\n${count || rows.length} match${(count || rows.length) === 1 ? "" : "es"}`;

  await replyOrEdit(ctx, text, keyboard, { parse_mode: "HTML" });
}

async function pickCountryById(ctx, countryId) {
  const data = ctx.session.data;
  // Need country meta — re-fetch from catalog cache (cheap because of the cache layer).
  const { rows } = await catalogApi.listCountries({
    telegramId: ctx.from.id,
    pageSize: 500,
  });
  const country = rows.find((c) => String(c.id) === String(countryId));
  if (!country) {
    await ctx.answerCbQuery("Country not found anymore. Refresh the list.");
    return;
  }
  data.country = country;
  data.serviceSearch = "";
  data.servicePage = 0;
  ctx.setStage(STAGES.SERVICE, data);
  await renderServiceStep(ctx, { firstRender: true });
}

// ---------------------------------------------------------------------------
// Service step
// ---------------------------------------------------------------------------

async function renderServiceStep(ctx, { firstRender = false } = {}) {
  const data = ctx.session.data;
  if (!data.country) {
    await ctx.reply("Please pick a country first. /order");
    return;
  }
  const { rows } = await catalogApi.listServicesByCountry({
    telegramId: ctx.from.id,
    countryId: data.country.id,
    page: 1,
    pageSize: 200,
    search: data.serviceSearch || undefined,
    sort: "cheapest",
  });

  if (!rows.length) {
    await replyOrEdit(
      ctx,
      `No services match that search for ${formatter.escapeHtml(data.country.name)}.`,
      menus.confirmKeyboard({
        confirmData: "order:service:reset",
        confirmLabel: "🔄 Reset search",
        cancelData: "flow:cancel",
      })
    );
    return;
  }

  const keyboard = menus.paginatedList({
    items: rows,
    pageIndex: data.servicePage || 0,
    pageSize: PAGE_SIZE,
    formatRow: (s) => formatServiceRowLabel(s),
    rowAction: (s) => `order:service:pick:${s.id}`,
    prevAction: "order:service:prev",
    nextAction: "order:service:next",
    extraRows: [
      [
        Markup.button.callback("🔍 Search", "order:service:search"),
        Markup.button.callback("🔄 Clear search", "order:service:reset"),
      ],
      [Markup.button.callback("⬅️ Change country", "order:back:country")],
    ],
  });

  const intro = firstRender
    ? "🧩 <b>Step 2/5 · Select service</b>\nServices are sorted by cheapest available price."
    : "🧩 <b>Step 2/5 · Select service</b>";

  const text =
    `${intro}\nCountry: <b>${formatter.escapeHtml(data.country.name)}</b>` +
    (data.serviceSearch ? `\nSearch: <code>${formatter.escapeHtml(data.serviceSearch)}</code>` : "");

  await replyOrEdit(ctx, text, keyboard, { parse_mode: "HTML" });
}

function formatServiceRowLabel(service) {
  const min = formatter.pickPriceMin(service.prices || []);
  const stock =
    service.totalStock !== undefined
      ? formatter.formatNumber(service.totalStock)
      : "?";
  const price = min ? formatter.formatMoney(min.sellPrice) : "—";
  const name = service.name || service.code || "?";
  const truncated = name.length > 22 ? `${name.slice(0, 21)}…` : name;
  return `${truncated} · ${price} · stk ${stock}`;
}

async function pickServiceById(ctx, serviceId) {
  const data = ctx.session.data;
  if (!data.country) return startOrder(ctx);

  const { rows } = await catalogApi.listServicesByCountry({
    telegramId: ctx.from.id,
    countryId: data.country.id,
    pageSize: 500,
    sort: "cheapest",
  });
  const service = rows.find((s) => String(s.id) === String(serviceId));
  if (!service) {
    await ctx.answerCbQuery("Service unavailable. Refreshing list.");
    await renderServiceStep(ctx);
    return;
  }
  data.service = service;
  ctx.setStage(STAGES.PRICE, data);
  await renderPriceStep(ctx, { firstRender: true });
}

// ---------------------------------------------------------------------------
// Price step
// ---------------------------------------------------------------------------

async function renderPriceStep(ctx, { firstRender = false } = {}) {
  const data = ctx.session.data;
  if (!data.service) return startOrder(ctx);

  const prices = (data.service.prices || []).slice().sort((a, b) => {
    return Number(a.sellPrice) - Number(b.sellPrice);
  });

  if (!prices.length) {
    await replyOrEdit(
      ctx,
      "No price tiers available for this service. Pick a different service.",
      menus.confirmKeyboard({
        confirmData: "order:back:service",
        confirmLabel: "⬅️ Back to services",
        cancelData: "flow:cancel",
      })
    );
    return;
  }

  const rows = prices.map((p) => [
    Markup.button.callback(
      `${formatter.formatMoney(p.sellPrice)} · stock ${
        p.stock !== undefined ? formatter.formatNumber(p.stock) : "?"
      }`,
      `order:price:pick:${p.id}`
    ),
  ]);
  rows.push([Markup.button.callback("⬅️ Back", "order:back:service")]);
  rows.push([Markup.button.callback("❌ Cancel", "flow:cancel")]);

  const intro = firstRender
    ? "💰 <b>Step 3/5 · Choose price tier</b>\nLower-priced tiers usually have less stock; pick the cheapest one with enough stock for your need."
    : "💰 <b>Step 3/5 · Choose price tier</b>";

  await replyOrEdit(
    ctx,
    `${intro}\nService: <b>${formatter.escapeHtml(data.service.name)}</b>\nCountry: <b>${formatter.escapeHtml(
      data.country.name
    )}</b>`,
    Markup.inlineKeyboard(rows),
    { parse_mode: "HTML" }
  );
}

async function pickPriceById(ctx, priceId) {
  const data = ctx.session.data;
  if (!data.service) return startOrder(ctx);
  const tier = (data.service.prices || []).find(
    (p) => String(p.id) === String(priceId)
  );
  if (!tier) {
    await ctx.answerCbQuery("Price tier not found. Refreshing list.");
    await renderPriceStep(ctx);
    return;
  }
  data.priceTier = tier;
  ctx.setStage(STAGES.OPERATOR, data);
  await renderOperatorStep(ctx, { firstRender: true });
}

// ---------------------------------------------------------------------------
// Operator step
// ---------------------------------------------------------------------------

async function renderOperatorStep(ctx, { firstRender = false } = {}) {
  const data = ctx.session.data;
  if (!data.country) return startOrder(ctx);

  const { rows } = await catalogApi.listOperators({
    telegramId: ctx.from.id,
    countryId: data.country.id,
    pageSize: 200,
  });

  const buttons = [
    [Markup.button.callback("🌐 Any operator", "order:op:pick:any")],
    ...rows.map((op) => [
      Markup.button.callback(
        op.name || op.code || "?",
        `order:op:pick:${op.id}`
      ),
    ]),
  ];
  buttons.push([Markup.button.callback("⬅️ Back", "order:back:price")]);
  buttons.push([Markup.button.callback("❌ Cancel", "flow:cancel")]);

  const intro = firstRender
    ? "📡 <b>Step 4/5 · Select operator</b>\nUse 🌐 Any operator to let the system choose."
    : "📡 <b>Step 4/5 · Select operator</b>";

  await replyOrEdit(
    ctx,
    `${intro}\nCountry: <b>${formatter.escapeHtml(data.country.name)}</b>\nService: <b>${formatter.escapeHtml(
      data.service.name
    )}</b>`,
    Markup.inlineKeyboard(buttons),
    { parse_mode: "HTML" }
  );
}

async function pickOperatorById(ctx, operatorId) {
  const data = ctx.session.data;
  if (operatorId === "any") {
    data.operator = null;
  } else {
    const { rows } = await catalogApi.listOperators({
      telegramId: ctx.from.id,
      countryId: data.country.id,
      pageSize: 500,
    });
    const op = rows.find((o) => String(o.id) === String(operatorId));
    if (!op) {
      await ctx.answerCbQuery("Operator not found.");
      return;
    }
    data.operator = op;
  }
  ctx.setStage(STAGES.QUANTITY, data);
  await renderQuantityStep(ctx);
}

// ---------------------------------------------------------------------------
// Quantity step
// ---------------------------------------------------------------------------

async function renderQuantityStep(ctx) {
  const data = ctx.session.data;
  const presets = [1, 2, 3, 5, 10];
  const rows = [
    presets.map((n) =>
      Markup.button.callback(String(n), `order:qty:pick:${n}`)
    ),
    [
      Markup.button.callback("✏️ Type quantity", "order:qty:type"),
      Markup.button.callback("⬅️ Back", "order:back:operator"),
    ],
    [Markup.button.callback("❌ Cancel", "flow:cancel")],
  ];

  await replyOrEdit(
    ctx,
    `🔢 <b>Step 5/5 · Quantity</b>\nDefault: <b>${data.quantity || 1}</b>. Pick a preset, or type your own (1–20).`,
    Markup.inlineKeyboard(rows),
    { parse_mode: "HTML" }
  );
}

async function setQuantity(ctx, value) {
  if (!validator.isPositiveInt(value, { min: 1, max: 20 })) {
    await ctx.reply("Quantity must be between 1 and 20. Try again.");
    return;
  }
  ctx.session.data.quantity = Number(value);
  ctx.setStage(STAGES.CONFIRM, ctx.session.data);
  await renderConfirmStep(ctx);
}

async function promptTypeQuantity(ctx) {
  ctx.session.data.awaitingQuantityInput = true;
  await ctx.reply("Type the quantity (a number between 1 and 20).");
}

async function handleQuantityMessage(ctx) {
  if (!ctx.session.data || !ctx.session.data.awaitingQuantityInput) return false;
  const text = (ctx.message && ctx.message.text) || "";
  if (!validator.isPositiveInt(text.trim(), { min: 1, max: 20 })) {
    await ctx.reply("Please send a number between 1 and 20.");
    return true;
  }
  ctx.session.data.awaitingQuantityInput = false;
  await setQuantity(ctx, text.trim());
  return true;
}

// ---------------------------------------------------------------------------
// Confirm + place order
// ---------------------------------------------------------------------------

async function renderConfirmStep(ctx) {
  const data = ctx.session.data;
  const tier = data.priceTier;
  const totalEstimate =
    Number(tier.sellPrice || 0) * Number(data.quantity || 1);

  const operatorLine = data.operator
    ? formatter.escapeHtml(data.operator.name || data.operator.code || "—")
    : "Any operator";

  const text =
    "<b>📦 Confirm order</b>\n" +
    `Country: <b>${formatter.escapeHtml(data.country.name)}</b>\n` +
    `Service: <b>${formatter.escapeHtml(data.service.name)}</b>\n` +
    `Operator: ${operatorLine}\n` +
    `Price tier: <b>${formatter.formatMoney(tier.sellPrice)}</b>\n` +
    `Quantity: <b>${data.quantity}</b>\n` +
    `Auto-search server: <b>${data.autoSearchServer ? "ON" : "OFF"}</b>\n` +
    `Estimated total: <b>${formatter.formatMoney(totalEstimate)}</b>\n\n` +
    "Press <b>Confirm</b> to charge your balance and rent the number(s).";

  await replyOrEdit(
    ctx,
    text,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Confirm & order", "order:confirm"),
        Markup.button.callback("❌ Cancel", "flow:cancel"),
      ],
      [
        Markup.button.callback(
          data.autoSearchServer ? "🔁 Disable auto-search" : "🔁 Enable auto-search",
          "order:toggle:autosearch"
        ),
        Markup.button.callback("⬅️ Change quantity", "order:back:quantity"),
      ],
    ]),
    { parse_mode: "HTML" }
  );
}

async function placeOrder(ctx) {
  const data = ctx.session.data;
  if (!data.priceTier) {
    await ctx.reply("Order context lost. Please start again with /order.");
    ctx.clearStage();
    return;
  }

  await ctx.reply("⏳ Placing your order …");

  let response;
  try {
    response = await orderApi.requestSingleService({
      telegramId: ctx.from.id,
      serviceCountryPriceId: data.priceTier.id,
      operatorId: data.operator ? data.operator.id : undefined,
      quantity: data.quantity || 1,
      autoSearchServer: !!data.autoSearchServer,
    });
  } catch (err) {
    logger.warn("Order placement failed", {
      err: err.message,
      code: err instanceof ApiError ? err.code : null,
    });
    if (err instanceof ApiError) {
      await ctx.reply(`❌ ${err.friendly}`);
    } else {
      await ctx.reply(`❌ ${err.message || "Failed to place order."}`);
    }
    return;
  }

  ctx.clearStage();

  // The single-service response shape is the latest activation summary.
  // Detail rows live on /v1/public/orders/ongoing-activation; we re-fetch to
  // persist the activation per number.
  let activations = [];
  try {
    const ongoing = await orderApi.listOngoingActivation({
      telegramId: ctx.from.id,
    });
    activations = ongoing.rows || [];
  } catch (err) {
    logger.warn("Failed to refresh ongoing activations after order", {
      err: err.message,
    });
  }

  // Persist as many recent activations as we just created.
  const limit = Math.max(1, Number(response && response.success) || data.quantity || 1);
  const persisted = [];
  for (const act of activations.slice(0, limit)) {
    ordersRepo.upsertFromActivation(ctx.from.id, act, {
      serviceName: data.service.name,
      countryName: data.country.name,
      countryCode: data.country.code,
      operatorName: data.operator ? data.operator.name : "Any",
      price: data.priceTier.sellPrice,
    });
    persisted.push(act);
  }

  if (persisted.length === 0) {
    await ctx.reply(
      "✅ Order placed. The activation will appear in 📦 <b>Active orders</b> in a few seconds.",
      { parse_mode: "HTML" }
    );
    return;
  }

  for (const act of persisted) {
    await ctx.reply(
      formatter.formatOrderSummary({
        serviceName: data.service.name,
        countryName: data.country.name,
        operatorName: data.operator ? data.operator.name : "Any",
        phoneNumber: act.phoneNumber,
        amount: data.priceTier.sellPrice,
        status: act.status,
        expiredTime: act.expiredTime,
      }, { maskPhone: false }),
      {
        parse_mode: "HTML",
        ...menus.orderActionsKeyboard({ activationId: act.id }),
      }
    );
  }

  // Refresh balance for the user, low-priority best-effort.
  try {
    const balance = await accountApi.getBalance({ telegramId: ctx.from.id });
    if (balance !== null) {
      await ctx.reply(formatter.formatBalance(balance), { parse_mode: "HTML" });
    }
  } catch (_) {
    // ignore balance failure
  }
}

// ---------------------------------------------------------------------------
// Smart-command shortcut: /order whatsapp indonesia 3
// ---------------------------------------------------------------------------

async function startSmartOrder(ctx, parsed) {
  if (!parsed) return startOrder(ctx);
  const { service: serviceKw, country: countryKw, quantity } = parsed;

  await ctx.reply("⏳ Resolving service and country …");

  // Country lookup
  let country = null;
  if (countryKw) {
    const res = await catalogApi.listCountries({
      telegramId: ctx.from.id,
      pageSize: 200,
      search: countryKw,
    });
    country = (res.rows || []).find((c) =>
      (c.name || "").toLowerCase().includes(countryKw.toLowerCase())
    );
  }
  if (!country) {
    await ctx.reply(
      `Could not find country "${countryKw || "—"}". Falling back to manual order.`
    );
    return startOrder(ctx);
  }

  const sres = await catalogApi.listServicesByCountry({
    telegramId: ctx.from.id,
    countryId: country.id,
    pageSize: 200,
    search: serviceKw,
    sort: "cheapest",
  });
  const service = (sres.rows || []).find((s) =>
    (s.name || s.code || "")
      .toLowerCase()
      .includes(serviceKw.toLowerCase())
  );
  if (!service) {
    await ctx.reply(
      `Could not find service "${serviceKw}" in ${country.name}. Falling back to manual order.`
    );
    return startOrder(ctx);
  }

  const tier = formatter.pickPriceMin(service.prices || []);
  if (!tier) {
    await ctx.reply(
      `No price tiers available for ${service.name} in ${country.name}. Try a different country.`
    );
    return;
  }

  const settings = settingsRepo.getOrCreate(ctx.from.id);
  ctx.setStage(STAGES.CONFIRM, {
    country,
    service,
    priceTier: tier,
    operator: null,
    quantity: quantity || settings.default_quantity || 1,
    autoSearchServer:
      settings.auto_search_server === undefined
        ? config.order.autoSearchServer
        : !!settings.auto_search_server,
  });

  await renderConfirmStep(ctx);
}

// ---------------------------------------------------------------------------
// Save current confirmed selection as favorite
// ---------------------------------------------------------------------------

async function saveSelectionAsFavorite(ctx) {
  const data = ctx.session.data;
  if (!data || !data.priceTier) {
    await ctx.reply("There is nothing to favorite right now.");
    return;
  }
  favoritesRepo.add(ctx.from.id, {
    countryId: data.country.id,
    countryName: data.country.name,
    serviceId: data.service.id,
    serviceName: data.service.name,
    serviceCountryPriceId: data.priceTier.id,
    operatorId: data.operator ? data.operator.id : null,
    operatorName: data.operator ? data.operator.name : null,
    quantity: data.quantity,
    autoSearchServer: !!data.autoSearchServer,
    name: `${data.service.name} · ${data.country.name}`,
  });
  await ctx.reply("⭐ Saved as favorite.");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function replyOrEdit(ctx, text, keyboard, extra = {}) {
  const opts = {
    ...keyboard,
    ...extra,
    disable_web_page_preview: true,
  };
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, opts);
      return;
    } catch (_) {
      // message may be too old to edit; fall through to new reply
    }
  }
  await ctx.reply(text, opts);
}

// ---------------------------------------------------------------------------
// Search prompt / message handlers
// ---------------------------------------------------------------------------

async function promptSearchCountry(ctx) {
  ctx.session.data.awaitingCountrySearch = true;
  await ctx.reply("Type a country name to filter (e.g. `indonesia`).");
}
async function promptSearchService(ctx) {
  ctx.session.data.awaitingServiceSearch = true;
  await ctx.reply("Type a service name or code (e.g. `whatsapp` or `wa`).");
}

async function handleTextDuringFlow(ctx) {
  const data = ctx.session.data || {};
  if (data.awaitingQuantityInput) {
    return handleQuantityMessage(ctx);
  }
  if (data.awaitingCountrySearch) {
    data.awaitingCountrySearch = false;
    data.countrySearch = validator.cleanUserText(ctx.message.text || "", 60);
    data.countryPage = 0;
    await renderCountryStep(ctx);
    return true;
  }
  if (data.awaitingServiceSearch) {
    data.awaitingServiceSearch = false;
    data.serviceSearch = validator.cleanUserText(ctx.message.text || "", 60);
    data.servicePage = 0;
    await renderServiceStep(ctx);
    return true;
  }
  return false;
}

module.exports = {
  STAGES,
  startOrder,
  startSmartOrder,
  renderCountryStep,
  renderServiceStep,
  renderPriceStep,
  renderOperatorStep,
  renderQuantityStep,
  renderConfirmStep,
  pickCountryById,
  pickServiceById,
  pickPriceById,
  pickOperatorById,
  promptTypeQuantity,
  promptSearchCountry,
  promptSearchService,
  setQuantity,
  placeOrder,
  saveSelectionAsFavorite,
  handleTextDuringFlow,
};
