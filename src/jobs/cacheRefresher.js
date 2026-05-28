"use strict";

/**
 * Cache refresher job.
 *
 * Two responsibilities:
 *   1. Purge expired rows from `catalog_cache` (cheap, frequent).
 *   2. Periodically pre-warm the catalog (countries) for a randomly-picked
 *      user that has an API key. This keeps the cache hot so menu screens
 *      always feel instant.
 *
 * Both tasks are scheduled with node-cron.
 */

const cron = require("node-cron");

const logger = require("../utils/logger");
const { cacheRepo, usersRepo } = require("../db/repositories");
const catalogApi = require("../api/catalogApi");

let purgeJob = null;
let warmJob = null;

function start() {
  if (purgeJob && warmJob) return;

  // Every 5 minutes: drop any expired catalog rows so the table stays small.
  purgeJob = cron.schedule("*/5 * * * *", () => {
    try {
      cacheRepo.purgeExpired();
    } catch (err) {
      logger.warn("cacheRefresher: purge failed", { err: err.message });
    }
  });

  // Every 30 minutes: warm the country list using one random user with an
  // API key. Services are warmed lazily on first access (per country).
  warmJob = cron.schedule("*/30 * * * *", async () => {
    try {
      await warmCountries();
    } catch (err) {
      logger.warn("cacheRefresher: warm failed", { err: err.message });
    }
  });

  logger.info("Cache refresher: scheduled (purge every 5m, warm every 30m)");
}

function stop() {
  if (purgeJob) {
    purgeJob.stop();
    purgeJob = null;
  }
  if (warmJob) {
    warmJob.stop();
    warmJob = null;
  }
}

async function warmCountries() {
  const candidates = usersRepo.listWithApiKey();
  if (!candidates.length) return;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  try {
    await catalogApi.listCountries({
      telegramId: pick.telegram_id,
      pageSize: 200,
      forceRefresh: true,
    });
    logger.debug("cacheRefresher: country list warmed", {
      telegramId: pick.telegram_id,
    });
  } catch (err) {
    logger.debug("cacheRefresher: country warm failed", {
      err: err.message,
    });
  }
}

module.exports = {
  start,
  stop,
  warmCountries,
};
