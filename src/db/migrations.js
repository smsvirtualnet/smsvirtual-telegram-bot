"use strict";

/**
 * Schema migrations.
 *
 * Strategy:
 * - A single `_migrations` table tracks which numbered migrations have run.
 * - Migrations are stored in this file as a list of { id, name, sql } records.
 * - Each migration is executed inside a transaction.
 * - Adding a new migration → append a new entry with the next id; never edit
 *   existing entries.
 */

const logger = require("../utils/logger");

const MIGRATIONS = [
  {
    id: 1,
    name: "init",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id     INTEGER NOT NULL UNIQUE,
        username        TEXT,
        first_name      TEXT,
        api_key         TEXT,
        api_key_masked  TEXT,
        is_allowed      INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS settings (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id              INTEGER NOT NULL UNIQUE,
        default_country_id       TEXT,
        default_country_name     TEXT,
        default_quantity         INTEGER DEFAULT 1,
        auto_search_server       INTEGER DEFAULT 1,
        otp_watcher_enabled      INTEGER DEFAULT 1,
        language                 TEXT DEFAULT 'en',
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS orders (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id       INTEGER NOT NULL,
        activation_id     TEXT,
        order_id          TEXT,
        invoice_no        TEXT,
        phone_number      TEXT,
        service_name      TEXT,
        service_code      TEXT,
        country_name      TEXT,
        country_code      TEXT,
        operator_name     TEXT,
        price             REAL,
        status            INTEGER,
        last_otp          TEXT,
        otp_notified      INTEGER NOT NULL DEFAULT 0,
        expired_at        TEXT,
        raw_json          TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_orders_telegram   ON orders (telegram_id);
      CREATE INDEX IF NOT EXISTS idx_orders_activation ON orders (activation_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders (status);

      CREATE TABLE IF NOT EXISTS favorites (
        id                       INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id              INTEGER NOT NULL,
        name                     TEXT,
        country_id               TEXT,
        country_name             TEXT,
        service_id               TEXT,
        service_name             TEXT,
        service_country_price_id TEXT,
        operator_id              TEXT,
        operator_name            TEXT,
        quantity                 INTEGER NOT NULL DEFAULT 1,
        auto_search_server       INTEGER NOT NULL DEFAULT 1,
        created_at               TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_favorites_telegram ON favorites (telegram_id);

      CREATE TABLE IF NOT EXISTS catalog_cache (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        cache_key    TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS deposits (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id       INTEGER NOT NULL,
        deposit_id        TEXT,
        deposit_method_id TEXT,
        amount            REAL,
        amount_coin       REAL,
        status            INTEGER,
        payment_data      TEXT,
        expired_at        TEXT,
        raw_json          TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_deposits_telegram ON deposits (telegram_id);
      CREATE INDEX IF NOT EXISTS idx_deposits_deposit  ON deposits (deposit_id);
    `,
  },
];

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function runMigrations(db) {
  ensureMigrationsTable(db);
  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((row) => row.id)
  );

  let count = 0;
  const insertMigration = db.prepare(
    "INSERT INTO _migrations (id, name) VALUES (?, ?)"
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    const txn = db.transaction(() => {
      db.exec(migration.sql);
      insertMigration.run(migration.id, migration.name);
    });

    try {
      txn();
      count += 1;
      logger.info(`Migration applied: ${migration.id} ${migration.name}`);
    } catch (err) {
      logger.error("Migration failed", {
        id: migration.id,
        name: migration.name,
        err: err.message,
      });
      throw err;
    }
  }

  if (count === 0) {
    logger.debug("No new migrations to apply");
  }

  return count;
}

module.exports = {
  runMigrations,
  MIGRATIONS,
};
