"use strict";

/**
 * Account-related endpoints under `/v1/public/*`.
 */

const client = require("./client");

async function getProfile({ telegramId, apiKeyOverride } = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/profile",
    telegramId,
    apiKeyOverride,
    contextLabel: "getProfile",
  });
  return result.data;
}

async function getBalance({ telegramId } = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/balance",
    telegramId,
    contextLabel: "getBalance",
  });
  // The shape is `{ balance }` after unwrap.
  if (!result.data) return null;
  return result.data.balance;
}

async function getBalanceHistory({
  telegramId,
  page = 1,
  pageSize = 10,
  startDate,
  endDate,
  type,
  category,
} = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/balance/history",
    telegramId,
    params: {
      page,
      pageSize,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(type !== undefined && type !== null ? { type } : {}),
      ...(category !== undefined && category !== null ? { category } : {}),
    },
    contextLabel: "getBalanceHistory",
  });
  // Returns { data, count, totalAddition, totalDeduction }.
  const payload = result.raw && result.raw.data ? result.raw : { data: result.data };
  return {
    rows: Array.isArray(payload.data) ? payload.data : [],
    count: payload.count || 0,
    totalAddition: Number(payload.totalAddition || 0),
    totalDeduction: Number(payload.totalDeduction || 0),
  };
}

module.exports = {
  getProfile,
  getBalance,
  getBalanceHistory,
};
