"use strict";

/**
 * /deposit flow.
 *
 * Stages:
 *   deposit:method   — pick a deposit method
 *   deposit:amount   — type deposit amount (COIN)
 *   deposit:confirm  — confirm before /v1/public/deposits/request
 *
 * Also handles:
 *   - /history (deposit) listing
 *   - cancel deposit by id (callback `deposit:cancel:<id>`)
 *
 * Sensitive payment data returned by the API (e.g. provider account numbers)
 * is rendered to the user but never logged.
 */

const { Markup } = require("telegraf");

const logger = require("../utils/logger");
const formatter = require("../utils/formatter");
const validator = require("../utils/validator");
const qr = require("../utils/qr");
const depositApi = require("../api/depositApi");
const { depositsRepo } = require("../db/repositories");
const menus = require("../bot/menus");
const { ApiError, toFriendlyMessage } = require("../utils/errors");

const STAGES = Object.freeze({
  METHOD: "deposit:method",
  AMOUNT: "deposit:amount",
  CONFIRM: "deposit:confirm",
});

const PAGE_SIZE = 6;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function startDeposit(ctx) {
  try {
    const { rows } = await depositApi.listDepositMethods({
      telegramId: ctx.from.id,
    });
    if (!rows.length) {
      await replyOrEdit(ctx, "⚠️ No active deposit methods are available right now.");
      return;
    }

    ctx.setStage(STAGES.METHOD, {
      methods: rows,
      methodPage: 0,
    });

    await replyOrEdit(ctx, buildMethodsText(rows, 0), buildMethodsKeyboard(rows, 0));
  } catch (err) {
    await replyOrEdit(ctx, `❌ ${formatter.escapeHtml(toFriendlyMessage(err))}`);
  }
}

function buildMethodsText(methods, page) {
  const totalPages = Math.max(1, Math.ceil(methods.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = methods.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const lines = slice.map(
    (m, idx) =>
      `${safePage * PAGE_SIZE + idx + 1}. ${formatter.formatDepositMethodRow(m)}`
  );
  return [
    "<b>💳 Select deposit method</b>",
    "",
    ...lines,
  ].join("\n");
}

function buildMethodsKeyboard(methods, page) {
  const totalPages = Math.max(1, Math.ceil(methods.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = methods.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const buttons = slice.map((m, idx) => {
    const absoluteIdx = safePage * PAGE_SIZE + idx;
    const label = (m.name || m.code || "Method").slice(0, 48);
    return [Markup.button.callback(label, `deposit:pick:${absoluteIdx}`)];
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback("⬅️ Prev", `deposit:methodpage:${safePage - 1}`));
  nav.push(Markup.button.callback(`Page ${safePage + 1}/${totalPages}`, "deposit:noop"));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback("Next ➡️", `deposit:methodpage:${safePage + 1}`));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback("❌ Cancel", "flow:cancel")]);

  return Markup.inlineKeyboard(buttons);
}

// ---------------------------------------------------------------------------
// Method selection
// ---------------------------------------------------------------------------

async function handleMethodPage(ctx, page) {
  const data = ctx.session.data || {};
  if (!data.methods) return startDeposit(ctx);
  data.methodPage = Math.max(0, page);
  await replyOrEdit(
    ctx,
    buildMethodsText(data.methods, data.methodPage),
    buildMethodsKeyboard(data.methods, data.methodPage)
  );
}

async function pickMethodIndex(ctx, idx) {
  const data = ctx.session.data || {};
  if (!data.methods || !data.methods[idx]) {
    await ctx.answerCbQuery("Selection expired. Please run /deposit again.", {
      show_alert: true,
    });
    return;
  }
  const method = data.methods[idx];
  ctx.setStage(STAGES.AMOUNT, {
    methods: data.methods,
    methodPage: data.methodPage,
    method,
  });

  const min = Number(method.minAmount || method.min || 0);
  const max = Number(method.maxAmount || method.max || 0);
  const lines = [
    `<b>💳 Method:</b> ${formatter.escapeHtml(method.name || method.code || "—")}`,
  ];
  if (method.note && method.note !== "-") {
    lines.push(`<b>Note:</b> ${formatter.escapeHtml(method.note)}`);
  }
  if (min) lines.push(`<b>Min:</b> ${formatter.formatMoney(min)}`);
  if (max) lines.push(`<b>Max:</b> ${formatter.formatMoney(max)}`);
  lines.push("");
  lines.push("Type the deposit amount in COIN (numbers only).");

  await replyOrEdit(
    ctx,
    lines.join("\n"),
    Markup.inlineKeyboard([
      [Markup.button.callback("❌ Cancel", "flow:cancel")],
    ])
  );
}

// ---------------------------------------------------------------------------
// Amount step
// ---------------------------------------------------------------------------

function isAwaitingAmount(ctx) {
  return ctx.session && ctx.session.stage === STAGES.AMOUNT;
}

async function handleAmountMessage(ctx) {
  const data = ctx.session.data || {};
  if (!data.method) {
    await ctx.reply("Please start over with /deposit.");
    ctx.clearStage();
    return;
  }
  const text = (ctx.message && ctx.message.text) || "";
  const cleaned = text.replace(/[^0-9]/g, "");
  if (!validator.isPositiveInt(cleaned, { min: 1, max: 10_000_000_000 })) {
    await ctx.reply("❌ Amount must be a positive whole number, e.g. 50000.");
    return;
  }
  const amount = Number(cleaned);

  const min = Number(data.method.minAmount || data.method.min || 0);
  const max = Number(data.method.maxAmount || data.method.max || 0);
  if (min && amount < min) {
    await ctx.reply(`❌ Amount must be at least ${formatter.formatMoney(min)}.`);
    return;
  }
  if (max && amount > max) {
    await ctx.reply(`❌ Amount must not exceed ${formatter.formatMoney(max)}.`);
    return;
  }

  ctx.setStage(STAGES.CONFIRM, { ...data, amount });

  const summary = [
    "<b>📥 Confirm deposit</b>",
    "",
    `<b>Method:</b> ${formatter.escapeHtml(data.method.name || data.method.code || "—")}`,
    `<b>Amount:</b> ${formatter.formatMoney(amount)}`,
    "",
    "Submit this deposit request?",
  ].join("\n");

  await ctx.reply(summary, {
    parse_mode: "HTML",
    ...menus.confirmKeyboard({
      confirmData: "deposit:submit",
      confirmLabel: "✅ Submit",
      cancelData: "flow:cancel",
    }),
  });
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function submitDeposit(ctx) {
  const data = ctx.session.data || {};
  if (!data.method || !data.amount) {
    await ctx.answerCbQuery("Selection expired. Please /deposit again.", {
      show_alert: true,
    });
    ctx.clearStage();
    return;
  }

  await ctx.answerCbQuery();

  // Reuse the confirm message as a "single bubble" we keep editing.
  // The user sees: Confirm  →  ⏳ Submitting …  →  ✅ Deposit created (or ❌ error).
  // The only case where a *second* message is unavoidable is the QR path:
  // Telegram doesn't allow morphing a text message into a photo, so we
  // delete the progress bubble and reply with the QR photo (still one
  // visible bubble at the end).
  const cbMsg = ctx.callbackQuery && ctx.callbackQuery.message;
  const chatId = cbMsg && cbMsg.chat && cbMsg.chat.id;
  const messageId = cbMsg && cbMsg.message_id;
  const canEdit = Boolean(chatId && messageId);

  await editInPlace(ctx, chatId, messageId, "⏳ Submitting deposit …", {
    parse_mode: "HTML",
  }, canEdit);

  let response;
  try {
    response = await depositApi.requestDeposit({
      telegramId: ctx.from.id,
      depositMethodId: data.method.id,
      amount: data.amount,
    });
  } catch (err) {
    logger.warn("Deposit submit failed", {
      err: err.message,
      code: err instanceof ApiError ? err.code : null,
    });
    const friendly = err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
    await editInPlace(
      ctx,
      chatId,
      messageId,
      `❌ ${formatter.escapeHtml(friendly)}`,
      { parse_mode: "HTML" },
      canEdit
    );
    return;
  } finally {
    ctx.clearStage();
  }

  try {
    depositsRepo.upsert(ctx.from.id, {
      ...response,
      depositMethodId: response.depositMethodId || data.method.id,
      amount: response.amount ?? data.amount,
    });
  } catch (err) {
    logger.warn("Failed to persist deposit", { err: err.message });
  }

  const keyboard = response && response.id
    ? menus.depositActionsKeyboard({ depositId: response.id })
    : null;

  // QR rendering path — only when the payload looks like a QRIS EMV string.
  const paymentData = response && response.paymentData;
  let qrBuffer = null;
  if (paymentData && qr.looksLikeQris(paymentData)) {
    qrBuffer = await qr.generateQrPngBuffer(paymentData);
  }

  if (qrBuffer) {
    const captionText = formatter.formatDepositRequest(
      { ...response, amount: response.amount ?? data.amount },
      { includePaymentData: false }
    );
    // Telegram doesn't allow editing a text message into a photo; delete
    // the progress message first so the chat stays at one bubble.
    if (canEdit) {
      try {
        await ctx.telegram.deleteMessage(chatId, messageId);
      } catch (_) {
        /* ignore — message may already be gone */
      }
    }
    try {
      await ctx.replyWithPhoto(
        { source: qrBuffer, filename: `deposit-${response.id || "qr"}.png` },
        {
          caption: captionText,
          parse_mode: "HTML",
          ...(keyboard || {}),
        }
      );
      return;
    } catch (err) {
      logger.warn("Deposit QR send failed, falling back to text", {
        err: err.message,
      });
      // fall through to plain text rendering below
    }
  }

  // Text-only path: render the final summary in the same bubble we've been
  // editing all along. Falls back to a fresh reply if the edit fails (e.g.
  // the source message is too old).
  const text = formatter.formatDepositRequest({
    ...response,
    amount: response.amount ?? data.amount,
  });
  await editInPlace(
    ctx,
    chatId,
    messageId,
    text,
    {
      parse_mode: "HTML",
      disable_web_page_preview: false,
      ...(keyboard || {}),
    },
    canEdit
  );
}

/**
 * Try to edit `messageId` in place; fall back to a fresh `ctx.reply` when
 * the edit fails or there's no source message id (e.g. text command path).
 */
async function editInPlace(ctx, chatId, messageId, text, extra, canEdit) {
  if (canEdit) {
    try {
      await ctx.telegram.editMessageText(
        chatId,
        messageId,
        undefined,
        text,
        extra
      );
      return;
    } catch (_) {
      /* fall through to reply */
    }
  }
  await ctx.reply(text, extra);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

async function showHistory(ctx, page = 1) {
  try {
    const { rows } = await depositApi.listHistory({
      telegramId: ctx.from.id,
      page,
      pageSize: 10,
    });
    if (!rows.length) {
      await ctx.reply("📭 No deposit history.");
      return;
    }
    const items = rows.map(
      (row, idx) => `${(page - 1) * 10 + idx + 1}. ${formatter.formatDepositHistoryRow(row)}`
    );
    await ctx.reply(
      [`<b>📜 Deposit history (page ${page})</b>`, "", items.join("\n\n")].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true }
    );
  } catch (err) {
    await ctx.reply(`❌ ${formatter.escapeHtml(toFriendlyMessage(err))}`, {
      parse_mode: "HTML",
    });
  }
}

// ---------------------------------------------------------------------------
// Cancel deposit by id
// ---------------------------------------------------------------------------

async function cancelDepositById(ctx, depositId) {
  try {
    await depositApi.cancelDeposit({ telegramId: ctx.from.id, id: depositId });
    await ctx.answerCbQuery("Deposit cancelled.");
    await ctx.reply(
      `Deposit <code>${formatter.escapeHtml(depositId)}</code> cancelled.`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    const msg = err instanceof ApiError ? err.friendly : toFriendlyMessage(err);
    await ctx.answerCbQuery(msg, { show_alert: true });
  }
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
  startDeposit,
  handleMethodPage,
  pickMethodIndex,
  handleAmountMessage,
  isAwaitingAmount,
  submitDeposit,
  showHistory,
  cancelDepositById,
};
