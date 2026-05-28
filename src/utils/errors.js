"use strict";

/**
 * ApiError + helpers for translating raw axios errors into a friendly
 * {message, friendly, code, status, retryable} envelope.
 *
 * The bot surfaces the `friendly` text to Telegram users; logs use `message`.
 */

class ApiError extends Error {
  constructor({
    code = "API_ERROR",
    message,
    friendly,
    status = 0,
    retryable = false,
    cause,
  }) {
    super(message || friendly || code);
    this.name = "ApiError";
    this.code = code;
    this.friendly = friendly || message || code;
    this.status = status;
    this.retryable = !!retryable;
    if (cause) this.cause = cause;
  }
}

const FRIENDLY_BY_CODE = {
  Unauthorized:
    "Your SMS Virtual API key was rejected. Please run /setup again to update it.",
  Forbidden:
    "This action is not allowed for your account. Contact SMS Virtual support if you believe this is wrong.",
  "Insufficient balance":
    "You do not have enough balance to place this order. Please top up via /deposit.",
  NO_NUMBERS:
    "No numbers are currently available for that service. Try again in a moment, switch the operator, or pick a different price tier.",
  BAD_SERVICE:
    "The selected service is not available right now. Please pick a different service.",
  BANNED:
    "Your account has been temporarily blocked from this service. Try a different service or contact support.",
  NOT_FOUND: "The requested item could not be found.",
  VALIDATION_FAILED: "Some of the values you sent were invalid. Please try again.",
  NETWORK_TIMEOUT:
    "The SMS Virtual server did not respond in time. Please try again in a few seconds.",
  SERVER_ERROR:
    "SMS Virtual returned a server error. Please try again shortly.",
  RATE_LIMITED:
    "You are sending requests too fast. Please slow down for a few seconds.",
};

function friendlyFor(code, fallback) {
  return FRIENDLY_BY_CODE[code] || fallback || "Something went wrong. Please try again.";
}

/**
 * Convert an axios error (or anything thrown) into ApiError.
 * Tries to read SMS Virtual's standard envelope: { statusCode, error, message }.
 */
function fromAxiosError(err, contextLabel = "API call") {
  // Network / connection failures (no response).
  if (err && err.code === "ECONNABORTED") {
    return new ApiError({
      code: "NETWORK_TIMEOUT",
      message: `${contextLabel}: timeout`,
      friendly: friendlyFor("NETWORK_TIMEOUT"),
      status: 0,
      retryable: true,
      cause: err,
    });
  }

  if (err && (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "EAI_AGAIN")) {
    return new ApiError({
      code: "NETWORK_ERROR",
      message: `${contextLabel}: ${err.code}`,
      friendly: "Cannot reach SMS Virtual right now. Check your internet connection and try again.",
      status: 0,
      retryable: true,
      cause: err,
    });
  }

  const response = err && err.response;
  const status = response && response.status;
  const data = response && response.data;

  // SMS Virtual envelope: { statusCode, error, message }
  const apiErrorCode =
    (data && (data.error || data.code)) || (status === 401 ? "Unauthorized" : null);
  const apiMessage = (data && (data.message || data.error)) || (err && err.message);

  if (status === 401) {
    return new ApiError({
      code: "Unauthorized",
      message: `${contextLabel}: 401 Unauthorized`,
      friendly: friendlyFor("Unauthorized"),
      status,
      retryable: false,
      cause: err,
    });
  }

  if (status === 403) {
    return new ApiError({
      code: "Forbidden",
      message: `${contextLabel}: 403 Forbidden`,
      friendly: friendlyFor("Forbidden"),
      status,
      retryable: false,
      cause: err,
    });
  }

  if (status === 404) {
    return new ApiError({
      code: "NOT_FOUND",
      message: `${contextLabel}: 404 Not Found`,
      friendly: friendlyFor("NOT_FOUND"),
      status,
      retryable: false,
      cause: err,
    });
  }

  if (status === 422) {
    return new ApiError({
      code: "VALIDATION_FAILED",
      message: `${contextLabel}: 422 ${apiMessage || "validation failed"}`,
      friendly: apiMessage || friendlyFor("VALIDATION_FAILED"),
      status,
      retryable: false,
      cause: err,
    });
  }

  if (status === 429) {
    return new ApiError({
      code: "RATE_LIMITED",
      message: `${contextLabel}: 429 Too Many Requests`,
      friendly: friendlyFor("RATE_LIMITED"),
      status,
      retryable: true,
      cause: err,
    });
  }

  if (status && status >= 500) {
    return new ApiError({
      code: "SERVER_ERROR",
      message: `${contextLabel}: ${status} ${apiMessage || ""}`.trim(),
      friendly: friendlyFor("SERVER_ERROR"),
      status,
      retryable: true,
      cause: err,
    });
  }

  // 4xx with a known business-error string.
  if (status && status >= 400 && apiErrorCode) {
    return new ApiError({
      code: apiErrorCode,
      message: `${contextLabel}: ${status} ${apiErrorCode}`,
      friendly: friendlyFor(apiErrorCode, apiMessage),
      status,
      retryable: false,
      cause: err,
    });
  }

  return new ApiError({
    code: "API_ERROR",
    message: `${contextLabel}: ${apiMessage || (err && err.message) || "unknown error"}`,
    friendly:
      "An unexpected error happened while talking to SMS Virtual. Please try again in a moment.",
    status: status || 0,
    retryable: !status || status >= 500,
    cause: err,
  });
}

/**
 * Translate an ApiError (or anything else thrown) into a friendly Telegram-safe
 * string.
 */
function toFriendlyMessage(err) {
  if (err instanceof ApiError) return err.friendly;
  if (err && typeof err.message === "string") return err.message;
  return "Something went wrong. Please try again.";
}

module.exports = {
  ApiError,
  fromAxiosError,
  friendlyFor,
  toFriendlyMessage,
};
