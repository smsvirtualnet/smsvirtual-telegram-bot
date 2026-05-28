"use strict";

/**
 * Repository layer — typed accessors over the SQLite tables.
 *
 * No business logic lives here, just CRUD. The bot/flows are responsible for
 * pulling data, deciding what to do, and persisting the result.
 */

const { getDatabase } = require("./database");
const sanitizer = require("../utils/sanitizer");

function db() {
  return getDatabase();
}

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

const usersRepo = {
  upsertFromTelegram({ telegramId, username, firstName }) {
    const stmt = db().prepare(`
      INSERT INTO users (telegram_id, username, first_name)
      VALUES (@telegramId, @username, @firstName)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username   = excluded.username,
        first_name = excluded.first_name,
        updated_at = datetime('now')
    `);
    stmt.run({
      telegramId,
      username: username || null,
      firstName: firstName || null,
    });
    return this.findByTelegramId(telegramId);
  },

  findByTelegramId(telegramId) {
    return db()
      .prepare("SELECT * FROM users WHERE telegram_id = ?")
      .get(telegramId) || null;
  },

  saveApiKey(telegramId, apiKey) {
    const masked = sanitizer.maskApiKey(apiKey);
    db()
      .prepare(
        `UPDATE users
            SET api_key = ?, api_key_masked = ?, updated_at = datetime('now')
          WHERE telegram_id = ?`
      )
      .run(apiKey, masked, telegramId);
    return this.findByTelegramId(telegramId);
  },

  clearApiKey(telegramId) {
    db()
      .prepare(
        `UPDATE users
            SET api_key = NULL, api_key_masked = NULL, updated_at = datetime('now')
          WHERE telegram_id = ?`
      )
      .run(telegramId);
  },

  setAllowed(telegramId, allowed) {
    db()
      .prepare(
        `UPDATE users
            SET is_allowed = ?, updated_at = datetime('now')
          WHERE telegram_id = ?`
      )
      .run(allowed ? 1 : 0, telegramId);
  },

  listUsers() {
    return db().prepare("SELECT * FROM users ORDER BY created_at ASC").all();
  },

  listAllowed() {
    return db()
      .prepare("SELECT * FROM users WHERE is_allowed = 1 ORDER BY created_at ASC")
      .all();
  },

  listWithApiKey() {
    return db()
      .prepare(
        `SELECT * FROM users
          WHERE api_key IS NOT NULL AND api_key <> ''
          ORDER BY created_at ASC`
      )
      .all();
  },
};

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

const settingsRepo = {
  getOrCreate(telegramId, defaults = {}) {
    let row = db()
      .prepare("SELECT * FROM settings WHERE telegram_id = ?")
      .get(telegramId);
    if (row) return row;

    db()
      .prepare(
        `INSERT INTO settings (telegram_id, default_quantity, auto_search_server, otp_watcher_enabled, language)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        telegramId,
        defaults.defaultQuantity ?? 1,
        defaults.autoSearchServer ? 1 : 1,
        defaults.otpWatcherEnabled ? 1 : 1,
        defaults.language || "en"
      );
    row = db()
      .prepare("SELECT * FROM settings WHERE telegram_id = ?")
      .get(telegramId);
    return row;
  },

  update(telegramId, patch) {
    const allowed = [
      "default_country_id",
      "default_country_name",
      "default_quantity",
      "auto_search_server",
      "otp_watcher_enabled",
      "language",
    ];
    const sets = [];
    const params = { telegramId };
    for (const key of allowed) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = patch[key];
      }
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    db()
      .prepare(
        `UPDATE settings SET ${sets.join(", ")} WHERE telegram_id = @telegramId`
      )
      .run(params);
  },
};

// ---------------------------------------------------------------------------
// orders
// ---------------------------------------------------------------------------

const ordersRepo = {
  upsertFromActivation(telegramId, activation, extra = {}) {
    const params = {
      telegramId,
      activationId: activation.id || activation.activationId || null,
      orderId: activation.orderId || (activation.order && activation.order.id) || null,
      invoiceNo:
        (activation.order &&
          activation.order.transaction &&
          activation.order.transaction.invoiceNo) ||
        extra.invoiceNo ||
        null,
      phoneNumber: activation.phoneNumber || null,
      serviceName:
        (activation.serviceCountry &&
          activation.serviceCountry.service &&
          activation.serviceCountry.service.name) ||
        extra.serviceName ||
        null,
      serviceCode:
        (activation.serviceCountry &&
          activation.serviceCountry.service &&
          activation.serviceCountry.service.code) ||
        extra.serviceCode ||
        null,
      countryName:
        (activation.serviceCountry &&
          activation.serviceCountry.country &&
          activation.serviceCountry.country.name) ||
        extra.countryName ||
        null,
      countryCode:
        (activation.serviceCountry &&
          activation.serviceCountry.country &&
          activation.serviceCountry.country.code) ||
        extra.countryCode ||
        null,
      operatorName:
        (activation.operator && activation.operator.name) ||
        extra.operatorName ||
        null,
      price: activation.servicePrice ?? activation.amount ?? extra.price ?? null,
      status:
        activation.status === undefined || activation.status === null
          ? null
          : Number(activation.status),
      expiredAt: activation.expiredTime || null,
      rawJson: JSON.stringify(activation),
    };

    const existing = params.activationId
      ? db()
          .prepare(
            "SELECT id FROM orders WHERE telegram_id = ? AND activation_id = ?"
          )
          .get(telegramId, params.activationId)
      : null;

    if (existing) {
      db()
        .prepare(
          `UPDATE orders SET
              order_id      = COALESCE(@orderId, order_id),
              invoice_no    = COALESCE(@invoiceNo, invoice_no),
              phone_number  = COALESCE(@phoneNumber, phone_number),
              service_name  = COALESCE(@serviceName, service_name),
              service_code  = COALESCE(@serviceCode, service_code),
              country_name  = COALESCE(@countryName, country_name),
              country_code  = COALESCE(@countryCode, country_code),
              operator_name = COALESCE(@operatorName, operator_name),
              price         = COALESCE(@price, price),
              status        = COALESCE(@status, status),
              expired_at    = COALESCE(@expiredAt, expired_at),
              raw_json      = @rawJson,
              updated_at    = datetime('now')
            WHERE id = @id`
        )
        .run({ ...params, id: existing.id });
      return existing.id;
    }

    const result = db()
      .prepare(
        `INSERT INTO orders (
           telegram_id, activation_id, order_id, invoice_no, phone_number,
           service_name, service_code, country_name, country_code, operator_name,
           price, status, expired_at, raw_json
         ) VALUES (
           @telegramId, @activationId, @orderId, @invoiceNo, @phoneNumber,
           @serviceName, @serviceCode, @countryName, @countryCode, @operatorName,
           @price, @status, @expiredAt, @rawJson
         )`
      )
      .run(params);
    return result.lastInsertRowid;
  },

  findById(id) {
    return db().prepare("SELECT * FROM orders WHERE id = ?").get(id);
  },

  findByActivationId(telegramId, activationId) {
    return db()
      .prepare(
        "SELECT * FROM orders WHERE telegram_id = ? AND activation_id = ?"
      )
      .get(telegramId, activationId);
  },

  listActiveForUser(telegramId, limit = 20) {
    return db()
      .prepare(
        `SELECT * FROM orders
          WHERE telegram_id = ?
            AND (status IS NULL OR status IN (0, 1, 2))
          ORDER BY created_at DESC
          LIMIT ?`
      )
      .all(telegramId, limit);
  },

  listActiveAcrossUsers(limit = 200) {
    return db()
      .prepare(
        `SELECT o.*
           FROM orders o
           JOIN users  u ON u.telegram_id = o.telegram_id
          WHERE o.activation_id IS NOT NULL
            AND (o.status IS NULL OR o.status IN (0, 1, 2))
            AND u.api_key IS NOT NULL AND u.api_key <> ''
          ORDER BY o.created_at DESC
          LIMIT ?`
      )
      .all(limit);
  },

  updateStatus(id, status) {
    db()
      .prepare(
        `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(Number(status), id);
  },

  setOtp(id, otpText, notified = false) {
    db()
      .prepare(
        `UPDATE orders SET last_otp = ?, otp_notified = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .run(otpText, notified ? 1 : 0, id);
  },

  markOtpNotified(id) {
    db()
      .prepare(
        `UPDATE orders SET otp_notified = 1, updated_at = datetime('now') WHERE id = ?`
      )
      .run(id);
  },
};

// ---------------------------------------------------------------------------
// favorites
// ---------------------------------------------------------------------------

const favoritesRepo = {
  add(telegramId, fav) {
    const result = db()
      .prepare(
        `INSERT INTO favorites (
           telegram_id, name,
           country_id, country_name,
           service_id, service_name,
           service_country_price_id,
           operator_id, operator_name,
           quantity, auto_search_server
         ) VALUES (
           @telegramId, @name,
           @countryId, @countryName,
           @serviceId, @serviceName,
           @serviceCountryPriceId,
           @operatorId, @operatorName,
           @quantity, @autoSearchServer
         )`
      )
      .run({
        telegramId,
        name: fav.name || `${fav.serviceName || "service"} · ${fav.countryName || "country"}`,
        countryId: fav.countryId || null,
        countryName: fav.countryName || null,
        serviceId: fav.serviceId || null,
        serviceName: fav.serviceName || null,
        serviceCountryPriceId: fav.serviceCountryPriceId || null,
        operatorId: fav.operatorId || null,
        operatorName: fav.operatorName || null,
        quantity: fav.quantity || 1,
        autoSearchServer: fav.autoSearchServer === false ? 0 : 1,
      });
    return result.lastInsertRowid;
  },

  list(telegramId) {
    return db()
      .prepare(
        `SELECT * FROM favorites WHERE telegram_id = ? ORDER BY created_at DESC`
      )
      .all(telegramId);
  },

  findById(telegramId, id) {
    return db()
      .prepare(`SELECT * FROM favorites WHERE telegram_id = ? AND id = ?`)
      .get(telegramId, id);
  },

  remove(telegramId, id) {
    db()
      .prepare(`DELETE FROM favorites WHERE telegram_id = ? AND id = ?`)
      .run(telegramId, id);
  },
};

// ---------------------------------------------------------------------------
// catalog cache
// ---------------------------------------------------------------------------

const cacheRepo = {
  get(key) {
    const row = db()
      .prepare(`SELECT payload_json, expires_at FROM catalog_cache WHERE cache_key = ?`)
      .get(key);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db().prepare(`DELETE FROM catalog_cache WHERE cache_key = ?`).run(key);
      return null;
    }
    try {
      return JSON.parse(row.payload_json);
    } catch (_) {
      return null;
    }
  },

  set(key, payload, ttlSeconds) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const json = JSON.stringify(payload);
    db()
      .prepare(
        `INSERT INTO catalog_cache (cache_key, payload_json, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           expires_at   = excluded.expires_at`
      )
      .run(key, json, expiresAt);
  },

  purgeExpired() {
    db()
      .prepare(`DELETE FROM catalog_cache WHERE expires_at < datetime('now')`)
      .run();
  },

  purgeAll() {
    db().prepare(`DELETE FROM catalog_cache`).run();
  },
};

// ---------------------------------------------------------------------------
// deposits
// ---------------------------------------------------------------------------

const depositsRepo = {
  upsert(telegramId, deposit) {
    const params = {
      telegramId,
      depositId: deposit.id || null,
      depositMethodId: deposit.depositMethodId || null,
      amount: deposit.amount ?? null,
      amountCoin: deposit.amountCoin ?? null,
      status:
        deposit.status === undefined || deposit.status === null
          ? null
          : Number(deposit.status),
      paymentData: deposit.paymentData || deposit.paymentUrl || null,
      expiredAt: deposit.expiredAt || null,
      rawJson: JSON.stringify(deposit),
    };

    const existing = params.depositId
      ? db()
          .prepare(
            `SELECT id FROM deposits WHERE telegram_id = ? AND deposit_id = ?`
          )
          .get(telegramId, params.depositId)
      : null;

    if (existing) {
      db()
        .prepare(
          `UPDATE deposits SET
              deposit_method_id = COALESCE(@depositMethodId, deposit_method_id),
              amount            = COALESCE(@amount, amount),
              amount_coin       = COALESCE(@amountCoin, amount_coin),
              status            = COALESCE(@status, status),
              payment_data      = COALESCE(@paymentData, payment_data),
              expired_at        = COALESCE(@expiredAt, expired_at),
              raw_json          = @rawJson,
              updated_at        = datetime('now')
            WHERE id = @id`
        )
        .run({ ...params, id: existing.id });
      return existing.id;
    }

    const result = db()
      .prepare(
        `INSERT INTO deposits (
           telegram_id, deposit_id, deposit_method_id, amount, amount_coin,
           status, payment_data, expired_at, raw_json
         ) VALUES (
           @telegramId, @depositId, @depositMethodId, @amount, @amountCoin,
           @status, @paymentData, @expiredAt, @rawJson
         )`
      )
      .run(params);
    return result.lastInsertRowid;
  },
};

module.exports = {
  usersRepo,
  settingsRepo,
  ordersRepo,
  favoritesRepo,
  cacheRepo,
  depositsRepo,
};
