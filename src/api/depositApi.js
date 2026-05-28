"use strict";

/**
 * Deposit endpoints — `/v1/public/deposits/*`.
 */

const client = require("./client");

async function listDepositMethods({ telegramId } = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/deposits",
    telegramId,
    contextLabel: "deposits.methods",
  });
  // Backend returns either an array directly or { data, count }.
  if (Array.isArray(result.data)) return { rows: result.data, count: result.data.length };
  if (result.raw && Array.isArray(result.raw.data)) {
    return { rows: result.raw.data, count: result.raw.count || result.raw.data.length };
  }
  return { rows: [], count: 0 };
}

async function listHistory({
  telegramId,
  page = 1,
  pageSize = 10,
  startDate,
  endDate,
  search,
  status,
  depositMethodId,
} = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/deposits/history",
    telegramId,
    params: {
      page,
      pageSize,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(search ? { search } : {}),
      ...(status !== undefined && status !== null ? { status } : {}),
      ...(depositMethodId ? { depositMethodId } : {}),
    },
    contextLabel: "deposits.history",
  });
  const raw = result.raw && result.raw.data ? result.raw : { data: result.data };
  return {
    rows: Array.isArray(raw.data) ? raw.data : [],
    total: raw.total || raw.count || 0,
  };
}

async function requestDeposit({
  telegramId,
  depositMethodId,
  amount,
  phoneNumber,
  idempotencyKey,
} = {}) {
  if (!depositMethodId) {
    throw new Error("requestDeposit: depositMethodId is required");
  }
  if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
    throw new Error("requestDeposit: amount must be a positive number");
  }
  const key = idempotencyKey || client.newIdempotencyKey();
  const result = await client.request({
    method: "POST",
    url: "/v1/public/deposits/request",
    telegramId,
    idempotencyKey: key,
    data: {
      depositMethodId,
      amount: Number(amount),
      ...(phoneNumber ? { phoneNumber } : {}),
    },
    contextLabel: "deposits.request",
    retry: false,
  });
  return result.data;
}

async function cancelDeposit({ telegramId, id } = {}) {
  if (!id) throw new Error("cancelDeposit: id is required");
  const idempotencyKey = client.newIdempotencyKey();
  const result = await client.request({
    method: "PUT",
    url: `/v1/public/deposits/cancel/${encodeURIComponent(id)}`,
    telegramId,
    idempotencyKey,
    contextLabel: `deposits.cancel(${id})`,
    retry: false,
  });
  return result.data;
}

module.exports = {
  listDepositMethods,
  listHistory,
  requestDeposit,
  cancelDeposit,
};
