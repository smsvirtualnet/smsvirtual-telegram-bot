"use strict";

/**
 * Sanitization helpers — strip / mask sensitive data before logging or
 * forwarding to Telegram.
 *
 * Used by `utils/logger.js` and the bot middleware that formats API errors.
 */

const SENSITIVE_KEYS = new Set([
  "api_key",
  "apikey",
  "x-api-key",
  "authorization",
  "auth",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "idempotency_key",
  "idempotency-key",
  "secret",
  "client_secret",
  "set-cookie",
  "cookie",
  "raw_json", // local DB blob — too noisy
]);

const OTP_FIELDS = new Set(["otp", "code", "verification_code"]);

/** Mask an API key as `abcd****wxyz`. */
function maskApiKey(value) {
  const v = typeof value === "string" ? value : String(value || "");
  if (!v) return "";
  if (v.length <= 8) return "****";
  return `${v.slice(0, 4)}****${v.slice(-4)}`;
}

/** Mask the middle of a phone number, keeping country prefix + last 3 digits. */
function maskPhoneNumber(value) {
  const v = String(value || "").replace(/[^\d+]/g, "");
  if (v.length < 6) return v;
  return `${v.slice(0, 3)}****${v.slice(-3)}`;
}

/** Mask an OTP / verification code. */
function maskOtp(value) {
  const v = String(value || "");
  if (!v) return v;
  if (v.length <= 2) return "**";
  return `${v.slice(0, 1)}***${v.slice(-1)}`;
}

/** Recursively redact sensitive fields. Returns a deep-cloned, safe object. */
function deepRedact(input, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (input === null || input === undefined) return input;
  if (Array.isArray(input)) return input.map((v) => deepRedact(v, depth + 1));

  if (typeof input === "object") {
    if (input instanceof Error) {
      return {
        name: input.name,
        message: input.message,
      };
    }
    const out = {};
    for (const key of Object.keys(input)) {
      const lower = key.toLowerCase();
      if (SENSITIVE_KEYS.has(lower)) {
        out[key] = "[REDACTED]";
        continue;
      }
      if (OTP_FIELDS.has(lower)) {
        out[key] = maskOtp(input[key]);
        continue;
      }
      if (lower.includes("apikey") || lower.includes("api_key")) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = deepRedact(input[key], depth + 1);
    }
    return out;
  }

  return input;
}

module.exports = {
  maskApiKey,
  maskPhoneNumber,
  maskOtp,
  deepRedact,
};
