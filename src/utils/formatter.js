"use strict";

/**
 * Telegram-friendly formatters. All output is plain text + Markdown V2 escapes
 * are NOT used — the bot emits HTML to keep escaping simple. Anything we
 * format here is meant to be consumed by `ctx.reply(text, { parse_mode: 'HTML' })`.
 */

const sanitizer = require("./sanitizer");

const ORDER_STATUS = {
  0: "PENDING",
  1: "SUCCESS",
  2: "EXPIRED",
  3: "CANCELLED",
  4: "REFUNDED",
  5: "CANCELLED_BUT_WAITING_CONFIRM",
};

const ACTIVATION_STATUS = {
  0: "PENDING",
  1: "READY",
  2: "RESEND",
  3: "SUCCESS",
  4: "COMPLETED",
  5: "CANCELLED",
  6: "EXPIRED",
  7: "REFUNDED",
  8: "CANCELLED_BUT_WAITING_CONFIRM",
};

const DEPOSIT_STATUS = {
  0: "PENDING",
  1: "SUCCESS",
  2: "FAILED",
  3: "EXPIRED",
  4: "REFUNDED",
};

const TRANSACTION_STATUS = {
  0: "PENDING",
  1: "SUCCESS",
  2: "FAILED",
  3: "REFUNDED",
  4: "EXPIRED",
};

const BALANCE_CATEGORY = {
  0: "ORDER",
  1: "CANCEL_ORDER",
  2: "REFUND_ORDER",
  3: "REACTIVATE_ORDER",
  4: "DEPOSIT",
  5: "REVOKE_DEPOSIT",
  6: "CLAIM_VOUCHER",
  7: "TRANSFER_BALANCE",
  8: "WITHDRAW",
  9: "REFUND_DEPOSIT",
  10: "REQUEST_BALANCE",
  11: "ADJUSTMENT",
};

function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

function formatNumber(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  return v.toLocaleString("en-US");
}

function formatMoney(n, currency = "COIN") {
  const v = Number(n);
  if (!Number.isFinite(v)) return `${currency} 0`;
  return `${currency} ${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatDate(isoOrDate) {
  if (!isoOrDate) return "—";
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function statusLabel(map, raw) {
  if (raw === undefined || raw === null) return "—";
  const key = Number(raw);
  return map[key] || String(raw);
}

function pickPriceMin(prices) {
  if (!Array.isArray(prices) || prices.length === 0) return null;
  let best = prices[0];
  for (const p of prices) {
    const sell = Number(p && p.sellPrice);
    const bestSell = Number(best && best.sellPrice);
    if (Number.isFinite(sell) && (!Number.isFinite(bestSell) || sell < bestSell)) {
      best = p;
    }
  }
  return best;
}

function formatProfile(profile) {
  if (!profile) return "Profile is not available.";
  const lines = [
    "<b>👤 Profile</b>",
    `Name: <b>${escapeHtml(profile.name || "—")}</b>`,
    `Email: <code>${escapeHtml(profile.email || "—")}</code>`,
    profile.phoneNumber
      ? `Phone: <code>${escapeHtml(profile.phoneNumber)}</code>`
      : null,
    profile.countryName
      ? `Default country: ${escapeHtml(profile.countryName)}`
      : null,
    `Status: ${profile.status === 1 ? "🟢 ACTIVE" : "⚪ INACTIVE"}`,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatBalance(balance) {
  if (balance === null || balance === undefined) return "Balance unavailable.";
  return `<b>💰 Balance</b>\n${formatMoney(balance)}`;
}

function formatBalanceHistory(rows = [], totals = {}) {
  if (!rows.length) {
    return "No balance history yet.";
  }
  const head = "<b>📒 Balance history</b>";
  const totalLine =
    `Added: <b>${formatMoney(totals.totalAddition || 0)}</b> · ` +
    `Spent: <b>${formatMoney(totals.totalDeduction || 0)}</b>`;
  const items = rows.slice(0, 10).map((row) => {
    const direction = Number(row.type) === 0 ? "➕" : "➖";
    const cat = statusLabel(BALANCE_CATEGORY, row.category);
    return [
      `${direction} ${formatMoney(row.amount)} (${escapeHtml(cat)})`,
      row.invoiceNo ? `   <code>${escapeHtml(row.invoiceNo)}</code>` : null,
      `   ${formatDate(row.createdAt)} · balance: ${formatMoney(
        row.currentBalance || 0
      )}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [head, totalLine, "", ...items].join("\n");
}

function formatCountryRow(country) {
  return `${escapeHtml(country.name || "—")} (code ${escapeHtml(
    country.code || "?"
  )})`;
}

function formatOperatorRow(op) {
  return escapeHtml(op.name || op.code || "—");
}

function formatServiceListRow(service) {
  const prices = service.prices || [];
  const min = pickPriceMin(prices);
  const stock =
    service.totalStock !== undefined
      ? formatNumber(service.totalStock)
      : "—";
  const minPrice = min ? formatMoney(min.sellPrice) : "—";
  return (
    `${escapeHtml(service.name || service.code || "—")}` +
    ` · stock <b>${stock}</b>` +
    ` · from <b>${minPrice}</b>`
  );
}

function formatPriceTier(tier) {
  return (
    `<b>${formatMoney(tier.sellPrice)}</b>` +
    (tier.stock !== undefined ? ` · stock ${formatNumber(tier.stock)}` : "") +
    (tier.failedOrderAttempts
      ? ` · recent failures: ${formatNumber(tier.failedOrderAttempts)}`
      : "")
  );
}

function formatOrderSummary(order, opts = {}) {
  const phone = opts.maskPhone
    ? sanitizer.maskPhoneNumber(order.phoneNumber || "")
    : order.phoneNumber || "—";
  const lines = [
    "<b>📦 Order</b>",
    order.serviceName ? `Service: <b>${escapeHtml(order.serviceName)}</b>` : null,
    order.countryName ? `Country: ${escapeHtml(order.countryName)}` : null,
    order.operatorName ? `Operator: ${escapeHtml(order.operatorName)}` : null,
    `Phone: <code>${escapeHtml(phone)}</code>`,
    order.amount !== undefined ? `Charged: ${formatMoney(order.amount)}` : null,
    order.status !== undefined
      ? `Status: <b>${statusLabel(ACTIVATION_STATUS, order.status)}</b>`
      : null,
    order.expiredTime ? `Expires: ${formatDate(order.expiredTime)}` : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatOtpNotification(order, otpText) {
  const phone = sanitizer.maskPhoneNumber(order.phoneNumber || "");
  return [
    "<b>📨 New OTP</b>",
    order.serviceName ? `Service: <b>${escapeHtml(order.serviceName)}</b>` : null,
    order.countryName ? `Country: ${escapeHtml(order.countryName)}` : null,
    `Phone: <code>${escapeHtml(phone)}</code>`,
    `Code: <code>${escapeHtml(otpText)}</code>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOrderHistoryRow(row) {
  return (
    `${formatDate(row.createdAt)}\n` +
    `   ${escapeHtml(row.serviceName || "—")} · ${escapeHtml(
      row.countryName || "—"
    )}\n` +
    `   ${formatMoney(row.amount)} · status ${statusLabel(
      ORDER_STATUS,
      row.status
    )}`
  );
}

function formatActivationRow(row) {
  return (
    `${formatDate(row.createdAt)}\n` +
    `   ${escapeHtml(row.serviceName || row.service?.name || "—")} · ` +
    `phone <code>${escapeHtml(
      sanitizer.maskPhoneNumber(row.phoneNumber || "")
    )}</code>\n` +
    `   status ${statusLabel(ACTIVATION_STATUS, row.status)}`
  );
}

function formatDepositMethodRow(method) {
  const min = formatMoney(method.minAmount || 0);
  return (
    `${escapeHtml(method.name || "—")}` +
    (method.note && method.note !== "-" ? ` · ${escapeHtml(method.note)}` : "") +
    ` · min ${min}`
  );
}

/**
 * Format the deposit summary.
 *
 * @param {object}  deposit
 * @param {object}  [opts]
 * @param {boolean} [opts.includePaymentData=true]  When false, omit the raw
 *   `Payment data:` block. The deposit flow uses this when it's about to
 *   send the EMV string as a QR image instead.
 */
function formatDepositRequest(deposit, opts = {}) {
  const { includePaymentData = true } = opts;
  const lines = [
    "<b>💳 Deposit created</b>",
    `Amount: <b>${formatMoney(deposit.amount)}</b>`,
    deposit.amountCoin && deposit.amountCoin !== deposit.amount
      ? `Coins credited on success: <b>${formatMoney(deposit.amountCoin)}</b>`
      : null,
    `Status: <b>${statusLabel(DEPOSIT_STATUS, deposit.status)}</b>`,
    deposit.expiredAt ? `Expires: ${formatDate(deposit.expiredAt)}` : null,
    deposit.paymentUrl
      ? `Payment link: <a href="${escapeHtml(
          deposit.paymentUrl
        )}">${escapeHtml(deposit.paymentUrl)}</a>`
      : null,
    includePaymentData && deposit.paymentData
      ? `Payment data:\n<code>${escapeHtml(deposit.paymentData)}</code>`
      : null,
  ].filter(Boolean);
  return lines.join("\n");
}

function formatDepositHistoryRow(row) {
  return (
    `${formatDate(row.createdAt)}\n` +
    `   ${escapeHtml(row.depositMethod?.name || "—")} · ${formatMoney(
      row.amount
    )}\n` +
    `   status ${statusLabel(DEPOSIT_STATUS, row.status)}` +
    (row.transaction?.invoiceNo
      ? `\n   <code>${escapeHtml(row.transaction.invoiceNo)}</code>`
      : "")
  );
}

module.exports = {
  escapeHtml,
  formatNumber,
  formatMoney,
  formatDate,
  statusLabel,
  pickPriceMin,
  formatProfile,
  formatBalance,
  formatBalanceHistory,
  formatCountryRow,
  formatOperatorRow,
  formatServiceListRow,
  formatPriceTier,
  formatOrderSummary,
  formatOtpNotification,
  formatOrderHistoryRow,
  formatActivationRow,
  formatDepositMethodRow,
  formatDepositRequest,
  formatDepositHistoryRow,
  ORDER_STATUS,
  ACTIVATION_STATUS,
  DEPOSIT_STATUS,
  TRANSACTION_STATUS,
  BALANCE_CATEGORY,
};
