"use strict";

/**
 * SMS Virtual public API HTTP client.
 *
 * Resolves the right `x-api-key` per call (preferring an explicit override,
 * then a stored per-user key, then the default key from .env). Wraps every
 * call in graceful error handling via `utils/errors.fromAxiosError`.
 *
 * Every endpoint here mirrors the OpenAPI documented in
 * `Docs/postman/sms-virtual-external.postman_collection.json` (which lives
 * outside of this submodule, but the same paths are also enforced in the
 * backend `virtusim-backend/src/public-api/*` controllers).
 */

const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const config = require("../config");
const logger = require("../utils/logger");
const sanitizer = require("../utils/sanitizer");
const { fromAxiosError, ApiError } = require("../utils/errors");
const { usersRepo } = require("../db/repositories");

const baseInstance = axios.create({
  baseURL: config.api.baseUrl,
  timeout: config.api.timeoutMs,
  headers: {
    "User-Agent": "smsvirtual-telegram-bot/1.0",
    Accept: "application/json",
  },
  // We unwrap response data ourselves so that `data.data` always works.
  validateStatus: (status) => status >= 200 && status < 300,
});

function resolveApiKey({ telegramId, override } = {}) {
  if (override && typeof override === "string") return override;
  if (telegramId) {
    const user = usersRepo.findByTelegramId(telegramId);
    if (user && user.api_key) return user.api_key;
  }
  if (config.api.defaultApiKey) return config.api.defaultApiKey;
  return null;
}

function buildHeaders({ apiKey, idempotencyKey }) {
  const headers = { "x-api-key": apiKey };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
    headers["idempotency-key"] = idempotencyKey;
  }
  return headers;
}

function unwrap(responseData) {
  if (responseData && Object.prototype.hasOwnProperty.call(responseData, "data")) {
    return responseData.data;
  }
  return responseData;
}

async function request({
  method,
  url,
  params,
  data,
  telegramId,
  apiKeyOverride,
  idempotencyKey,
  contextLabel,
  retry = true,
} = {}) {
  const apiKey = resolveApiKey({
    telegramId,
    override: apiKeyOverride,
  });

  if (!apiKey) {
    throw new ApiError({
      code: "Unauthorized",
      message: `${contextLabel || url}: missing API key`,
      friendly:
        "No SMS Virtual API key is configured for this account yet. Please run /setup to add your key.",
      status: 401,
    });
  }

  const headers = buildHeaders({ apiKey, idempotencyKey });

  const reqLabel = contextLabel || `${method.toUpperCase()} ${url}`;
  const start = Date.now();

  let attempt = 0;
  const maxAttempts = retry ? 2 : 1;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const response = await baseInstance.request({
        method,
        url,
        params,
        data,
        headers,
      });
      logger.debug(`API ok: ${reqLabel}`, {
        status: response.status,
        durationMs: Date.now() - start,
      });
      return {
        raw: response.data,
        data: unwrap(response.data),
        status: response.status,
        meta: response.data && response.data.statusCode
          ? { statusCode: response.data.statusCode, message: response.data.message }
          : null,
      };
    } catch (err) {
      const apiErr = fromAxiosError(err, reqLabel);
      logger.warn(`API failed: ${reqLabel}`, {
        attempt,
        code: apiErr.code,
        status: apiErr.status,
        retryable: apiErr.retryable,
        message: apiErr.message,
      });

      if (apiErr.retryable && attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }
      throw apiErr;
    }
  }

  throw new ApiError({
    code: "API_ERROR",
    message: `${reqLabel}: exhausted retries`,
    friendly: "SMS Virtual is unreachable right now. Please try again shortly.",
    retryable: true,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Light-weight credential probe — used by /setup to validate a freshly
 * supplied API key without persisting it. Returns the unwrapped profile or
 * throws an ApiError.
 */
async function probeApiKey(apiKey) {
  if (!apiKey) {
    throw new ApiError({
      code: "VALIDATION_FAILED",
      message: "probeApiKey called without a key",
      friendly: "Please paste a valid API key.",
    });
  }
  const result = await request({
    method: "GET",
    url: "/v1/public/profile",
    apiKeyOverride: apiKey,
    contextLabel: "probeApiKey",
    retry: false,
  });
  return result.data;
}

module.exports = {
  request,
  probeApiKey,
  resolveApiKey,
  newIdempotencyKey: () => uuidv4(),
  // Exposed for tests / debugging.
  _baseInstance: baseInstance,
  _maskApiKey: sanitizer.maskApiKey,
};
