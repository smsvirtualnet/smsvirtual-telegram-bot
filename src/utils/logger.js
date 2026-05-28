"use strict";

/**
 * Lightweight, dependency-free logger used everywhere in the bot.
 *
 * - Honours config.logging.level (debug | info | warn | error).
 * - Optionally appends JSON-line logs to data/bot.log when LOG_TO_FILE=true.
 * - Sanitizes sensitive fields (api keys, tokens, OTPs) before printing.
 */

const fs = require("fs");
const path = require("path");
const config = require("../config");
const sanitizer = require("./sanitizer");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const activeLevel = LEVELS[config.logging.level] || LEVELS.info;

let fileStream = null;
if (config.logging.toFile) {
  try {
    fs.mkdirSync(path.dirname(config.logging.file), { recursive: true });
    fileStream = fs.createWriteStream(config.logging.file, { flags: "a" });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[logger] Failed to open log file:", err.message);
  }
}

function shouldLog(level) {
  return LEVELS[level] >= activeLevel;
}

function format(level, message, meta) {
  const ts = new Date().toISOString();
  const safeMeta = meta ? sanitizer.deepRedact(meta) : undefined;
  return {
    ts,
    level,
    msg: message,
    ...(safeMeta ? { meta: safeMeta } : {}),
  };
}

function emit(level, message, meta) {
  if (!shouldLog(level)) return;

  const entry = format(level, message, meta);
  const line = `[${entry.ts}] ${level.toUpperCase().padEnd(5)} ${entry.msg}${
    entry.meta ? " " + safeStringify(entry.meta) : ""
  }`;

  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  if (fileStream) {
    try {
      fileStream.write(JSON.stringify(entry) + "\n");
    } catch (_) {
      // best-effort
    }
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return "[unserializable]";
  }
}

module.exports = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info: (msg, meta) => emit("info", msg, meta),
  warn: (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
};
