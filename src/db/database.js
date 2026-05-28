"use strict";

/**
 * SQLite singleton. Uses better-sqlite3 (synchronous, fast, no callbacks).
 *
 * The first call to `getDatabase()` opens the file and applies pragmas;
 * subsequent calls reuse the same handle.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("../config");
const logger = require("../utils/logger");

let db = null;

function getDatabase() {
  if (db) return db;

  const file = config.database.file;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");

  logger.info("Database opened", { file });
  return db;
}

function closeDatabase() {
  if (db) {
    try {
      db.close();
    } catch (err) {
      logger.warn("Error closing database", { err: err.message });
    }
    db = null;
  }
}

module.exports = {
  getDatabase,
  closeDatabase,
};
