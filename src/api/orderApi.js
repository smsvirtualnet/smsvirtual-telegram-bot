"use strict";

/**
 * Order endpoints — `/v1/public/orders/*`.
 *
 * Idempotency keys are generated client-side on POST/PUT mutations and passed
 * through both `Idempotency-Key` and `idempotency-key` headers (the backend
 * accepts either casing).
 */

const client = require("./client");

async function listHistory({
  telegramId,
  page = 1,
  pageSize = 10,
  startDate,
  endDate,
  search,
  status,
} = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/orders/history",
    telegramId,
    params: {
      page,
      pageSize,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(search ? { search } : {}),
      ...(status !== undefined && status !== null ? { status } : {}),
    },
    contextLabel: "orders.history",
  });
  const raw = result.raw && result.raw.data ? result.raw : { data: result.data };
  return {
    rows: Array.isArray(raw.data) ? raw.data : [],
    total: raw.total || raw.count || 0,
  };
}

async function listHistoryActivation({
  telegramId,
  page = 1,
  pageSize = 10,
  startDate,
  endDate,
  search,
  status,
} = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/orders/history-activation",
    telegramId,
    params: {
      page,
      pageSize,
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      ...(search ? { search } : {}),
      ...(status !== undefined && status !== null ? { status } : {}),
    },
    contextLabel: "orders.history-activation",
  });
  const raw = result.raw && result.raw.data ? result.raw : { data: result.data };
  return {
    rows: Array.isArray(raw.data) ? raw.data : [],
    total: raw.total || raw.count || 0,
  };
}

async function listOngoingActivation({ telegramId } = {}) {
  const result = await client.request({
    method: "GET",
    url: "/v1/public/orders/ongoing-activation",
    telegramId,
    contextLabel: "orders.ongoing-activation",
  });
  const data = result.data;
  if (Array.isArray(data)) return { rows: data };
  if (data && Array.isArray(data.data)) return { rows: data.data };
  if (data && typeof data === "object") return { rows: [data] };
  return { rows: [] };
}

/**
 * Place a single-service order.
 *
 * Required: serviceCountryPriceId.
 * Optional: operatorId, quantity, autoSearchServer.
 */
async function requestSingleService({
  telegramId,
  serviceCountryPriceId,
  operatorId,
  quantity = 1,
  autoSearchServer = false,
  idempotencyKey,
} = {}) {
  if (!serviceCountryPriceId) {
    throw new Error("requestSingleService: serviceCountryPriceId is required");
  }
  const key = idempotencyKey || client.newIdempotencyKey();
  const result = await client.request({
    method: "POST",
    url: "/v1/public/orders/request-single-service",
    telegramId,
    idempotencyKey: key,
    data: {
      serviceCountryPriceId,
      ...(operatorId ? { operatorId } : {}),
      quantity,
      autoSearchServer: !!autoSearchServer,
    },
    contextLabel: "orders.request-single-service",
    retry: false,
  });
  return result.data;
}

async function getStatus({ telegramId, id } = {}) {
  if (!id) throw new Error("getStatus: id is required");
  const result = await client.request({
    method: "GET",
    url: `/v1/public/orders/getStatus/${encodeURIComponent(id)}`,
    telegramId,
    contextLabel: `orders.getStatus(${id})`,
  });
  // The endpoint returns either { data: '<otp>' } or { data: null } / { data: {...} }.
  return result.data;
}

async function markReady({ telegramId, id } = {}) {
  return mutate({
    telegramId,
    method: "PUT",
    url: `/v1/public/orders/ready/${encodeURIComponent(id)}`,
    label: `orders.ready(${id})`,
  });
}

async function resend({ telegramId, id } = {}) {
  return mutate({
    telegramId,
    method: "PUT",
    url: `/v1/public/orders/resend/${encodeURIComponent(id)}`,
    label: `orders.resend(${id})`,
  });
}

async function cancel({ telegramId, id } = {}) {
  return mutate({
    telegramId,
    method: "PUT",
    url: `/v1/public/orders/cancel/${encodeURIComponent(id)}`,
    label: `orders.cancel(${id})`,
  });
}

async function complete({ telegramId, id } = {}) {
  return mutate({
    telegramId,
    method: "PUT",
    url: `/v1/public/orders/complete/${encodeURIComponent(id)}`,
    label: `orders.complete(${id})`,
  });
}

async function mutate({ telegramId, method, url, label }) {
  const idempotencyKey = client.newIdempotencyKey();
  const result = await client.request({
    method,
    url,
    telegramId,
    idempotencyKey,
    contextLabel: label,
    retry: false,
  });
  return result.data;
}

module.exports = {
  listHistory,
  listHistoryActivation,
  listOngoingActivation,
  requestSingleService,
  getStatus,
  markReady,
  resend,
  cancel,
  complete,
};
