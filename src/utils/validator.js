"use strict";

/**
 * Validation helpers for user input parsed from the Telegram chat / callbacks.
 */

const ApiKeyShape = /^[A-Za-z0-9_\-:.]{16,}$/;
const UuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PositiveIntShape = /^[0-9]{1,9}$/;

function isValidApiKeyFormat(value) {
  return typeof value === "string" && ApiKeyShape.test(value.trim());
}

function isValidUuid(value) {
  return typeof value === "string" && UuidShape.test(value.trim());
}

function isPositiveInt(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= min && value <= max;
  }
  if (typeof value !== "string") return false;
  if (!PositiveIntShape.test(value.trim())) return false;
  const n = Number(value.trim());
  return n >= min && n <= max;
}

function parseInteger(value, fallback = null) {
  const n = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse "/order whatsapp indonesia 3" → { service:'whatsapp', country:'indonesia', quantity:3 }.
 *
 * Returns `null` when the input has no real arguments (e.g. just "/order"),
 * so the caller can fall back to the multi-step flow.
 *
 * Quirks handled:
 *   - Strip a leading `/cmd` (or `/cmd@botname`) token if present.
 *   - Trailing integer 1..20 is treated as the quantity, otherwise 1.
 *   - Single-word forms like "/order whatsapp" return country=null.
 */
function parseSmartOrderArgs(argString) {
  const tokens = String(argString || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) return null;

  // Drop a leading slash-command token. Telegram may also append `@botname`.
  if (tokens[0].startsWith("/")) tokens.shift();
  if (tokens.length === 0) return null;

  let quantity = 1;
  if (/^\d+$/.test(tokens[tokens.length - 1])) {
    const n = parseInt(tokens[tokens.length - 1], 10);
    if (n >= 1 && n <= 20) {
      quantity = n;
      tokens.pop();
    }
  }

  if (tokens.length === 0) return null;

  const service = tokens[0];
  const country = tokens.slice(1).join(" ").trim() || null;

  return { service, country, quantity };
}

/** Trim, collapse whitespace, drop control characters from user input. */
function cleanUserText(value, maxLength = 80) {
  const v = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (v.length > maxLength) return v.slice(0, maxLength);
  return v;
}

module.exports = {
  isValidApiKeyFormat,
  isValidUuid,
  isPositiveInt,
  parseInteger,
  parseSmartOrderArgs,
  cleanUserText,
};
