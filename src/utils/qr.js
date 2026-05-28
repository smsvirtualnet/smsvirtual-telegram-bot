"use strict";

/**
 * QR code helpers.
 *
 * Wraps the pure-JS `qrcode` package so the rest of the codebase doesn't
 * need to know its options. The bot uses this to render QRIS EMV payment
 * strings (returned by SMS Virtual under `deposit.paymentData`) into a
 * scannable image that we attach to the deposit message.
 *
 * Notes:
 *   - QR Version 40 has a hard limit around 2,950 alphanumeric chars at
 *     error-correction level M. We reject anything longer to keep the
 *     output readable on a phone screen.
 *   - The PNG buffer is ~10–20 KB, well under Telegram's 10 MB photo cap.
 *   - We never throw on user-facing failures — callers fall back to a plain
 *     text rendering when this returns `null`.
 */

const QRCode = require("qrcode");

const MAX_INPUT_LEN = 2950;

const DEFAULT_OPTS = Object.freeze({
  errorCorrectionLevel: "M",
  margin: 2,
  width: 600,
  type: "png",
  color: {
    dark: "#000000",
    light: "#FFFFFF",
  },
});

/**
 * Render `text` as a PNG `Buffer`. Returns null on failure rather than
 * throwing so call sites can fall back gracefully.
 */
async function generateQrPngBuffer(text, opts = {}) {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_INPUT_LEN) return null;
  try {
    return await QRCode.toBuffer(trimmed, { ...DEFAULT_OPTS, ...opts });
  } catch (_err) {
    return null;
  }
}

/**
 * Heuristic to detect Indonesian QRIS EMV strings.
 * Format: starts with "00020101" (static) or "00020102" (dynamic) per
 * EMVCo Merchant-Presented Mode.
 */
function looksLikeQris(text) {
  if (typeof text !== "string") return false;
  return /^00020[12]/.test(text.trim());
}

module.exports = {
  generateQrPngBuffer,
  looksLikeQris,
  MAX_INPUT_LEN,
};
