"use strict";

/**
 * Catalog endpoints — countries, operators, services, services/list.
 *
 * Cached locally via `cacheRepo` to keep API usage low. Cache keys are scoped
 * by user only when the search/filter shape implies a user-specific result;
 * generic country/service listings are shared across all users.
 */

const client = require("./client");
const config = require("../config");
const { cacheRepo } = require("../db/repositories");

function cacheKey(parts) {
  return parts.filter(Boolean).join(":");
}

async function listCountries({
  telegramId,
  page = 1,
  pageSize = 50,
  search,
  forceRefresh = false,
} = {}) {
  const key = cacheKey([
    "countries",
    `p=${page}`,
    `s=${pageSize}`,
    `q=${(search || "").toLowerCase().trim()}`,
  ]);
  if (!forceRefresh) {
    const cached = cacheRepo.get(key);
    if (cached) return cached;
  }

  const result = await client.request({
    method: "GET",
    url: "/v1/public/countries",
    telegramId,
    params: {
      page,
      pageSize,
      ...(search ? { search } : {}),
    },
    contextLabel: "listCountries",
  });

  const payload = {
    rows: Array.isArray(result.data) ? result.data : (result.raw && result.raw.data) || [],
    count: (result.raw && result.raw.count) || 0,
  };
  cacheRepo.set(key, payload, config.cache.catalogTtlSeconds);
  return payload;
}

async function listOperators({
  telegramId,
  countryId,
  page = 1,
  pageSize = 100,
  forceRefresh = false,
} = {}) {
  const key = cacheKey(["operators", `c=${countryId || ""}`, `p=${page}`, `s=${pageSize}`]);
  if (!forceRefresh) {
    const cached = cacheRepo.get(key);
    if (cached) return cached;
  }

  const result = await client.request({
    method: "GET",
    url: "/v1/public/operators",
    telegramId,
    params: {
      page,
      pageSize,
      ...(countryId ? { countryId } : {}),
    },
    contextLabel: "listOperators",
  });

  const payload = {
    rows: Array.isArray(result.data) ? result.data : (result.raw && result.raw.data) || [],
    count: (result.raw && result.raw.count) || 0,
  };
  cacheRepo.set(key, payload, config.cache.catalogTtlSeconds);
  return payload;
}

async function listServices({
  telegramId,
  page = 1,
  pageSize = 50,
  search,
  categoryId,
  status,
  sort,
  forceRefresh = false,
} = {}) {
  const key = cacheKey([
    "services",
    `p=${page}`,
    `s=${pageSize}`,
    `q=${(search || "").toLowerCase().trim()}`,
    `cat=${categoryId || ""}`,
    `st=${status === undefined || status === null ? "" : status}`,
    `o=${sort || ""}`,
  ]);
  if (!forceRefresh) {
    const cached = cacheRepo.get(key);
    if (cached) return cached;
  }

  const result = await client.request({
    method: "GET",
    url: "/v1/public/services",
    telegramId,
    params: {
      page,
      pageSize,
      ...(search ? { search } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(status !== undefined && status !== null ? { status } : {}),
      ...(sort ? { sort } : {}),
    },
    contextLabel: "listServices",
  });

  const payload = {
    rows: Array.isArray(result.data) ? result.data : (result.raw && result.raw.data) || [],
    count: (result.raw && result.raw.count) || 0,
  };
  cacheRepo.set(key, payload, config.cache.catalogTtlSeconds);
  return payload;
}

async function listServicesByCountry({
  telegramId,
  countryId,
  page = 1,
  pageSize = 50,
  search,
  categoryId,
  status,
  sort = "cheapest",
  forceRefresh = false,
} = {}) {
  if (!countryId) {
    throw new Error("listServicesByCountry: countryId is required");
  }
  const key = cacheKey([
    "services-list",
    `c=${countryId}`,
    `p=${page}`,
    `s=${pageSize}`,
    `q=${(search || "").toLowerCase().trim()}`,
    `cat=${categoryId || ""}`,
    `st=${status === undefined || status === null ? "" : status}`,
    `o=${sort || ""}`,
  ]);
  if (!forceRefresh) {
    const cached = cacheRepo.get(key);
    if (cached) return cached;
  }

  const result = await client.request({
    method: "GET",
    url: "/v1/public/services/list",
    telegramId,
    params: {
      countryId,
      page,
      pageSize,
      ...(search ? { search } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(status !== undefined && status !== null ? { status } : {}),
      ...(sort ? { sort } : {}),
    },
    contextLabel: "listServicesByCountry",
  });

  const payload = {
    rows: Array.isArray(result.data) ? result.data : (result.raw && result.raw.data) || [],
    count: (result.raw && result.raw.count) || 0,
  };
  cacheRepo.set(key, payload, config.cache.catalogTtlSeconds);
  return payload;
}

module.exports = {
  listCountries,
  listOperators,
  listServices,
  listServicesByCountry,
};
