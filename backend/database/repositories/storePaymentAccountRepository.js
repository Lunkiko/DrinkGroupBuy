"use strict";

const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("..");

// Multi-channel LINE Pay accounts (2026-10-22): Postgres-only from day one, same reasoning as
// merchantApplicationRepository.js and merchantRefundMarkRepository.js -- this table didn't exist
// before this feature, and the project's runtime has already permanently switched to PostgreSQL.
function createStorePaymentAccountRepository(input = {}) {
  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    getOrderStoreId: (value) => getOrderStoreIdPostgres(database, value),
    getActiveAccountForStore: (value) => getActiveAccountForStorePostgres(database, value),
    upsertAccount: (value) => upsertAccountPostgres(database, value),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

async function getOrderStoreIdPostgres(database, { orderId }) {
  const result = await database.query(`
    SELECT activity.store_id AS store_id
    FROM orders
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    WHERE orders.id = $1
  `, [orderId]);
  return result.rows[0]?.store_id || null;
}

// Returns null when the store has no active account for this provider -- the caller
// (linePayService.js's resolveLinePayAccountOverrides) treats null as "fall back to the global
// LINE_PAY_CHANNEL_ID/SECRET env vars", not as an error: most stores won't have a row here yet
// during rollout, and every existing/future order must keep working with the shared account until
// a store is explicitly given its own.
async function getActiveAccountForStorePostgres(database, { storeId, provider }) {
  const result = await database.query(`
    SELECT channel_id, channel_secret
    FROM store_payment_accounts
    WHERE store_id = $1 AND provider = $2 AND status = 'active'
  `, [storeId, provider]);
  const row = result.rows[0];
  if (!row) return null;
  return { channelId: row.channel_id, channelSecret: row.channel_secret };
}

// Seed/admin-only write path (used by the mock-account seed script, not by any payment request path).
// Upserts on (store_id, provider) so re-running the seed script is idempotent.
async function upsertAccountPostgres(database, { storeId, provider, channelId, channelSecret, status = "active" }) {
  const now = new Date().toISOString();
  const id = `store-payment-account-${randomUUID()}`;
  const result = await database.query(`
    INSERT INTO store_payment_accounts (id, store_id, provider, channel_id, channel_secret, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
    ON CONFLICT (store_id, provider) DO UPDATE SET
      channel_id = EXCLUDED.channel_id,
      channel_secret = EXCLUDED.channel_secret,
      status = EXCLUDED.status,
      updated_at = EXCLUDED.updated_at
    RETURNING id, store_id, provider, channel_id, channel_secret, status
  `, [id, storeId, provider, channelId, channelSecret, status, now]);
  return mapAccount(result.rows[0]);
}

function mapAccount(row) {
  return {
    id: row.id,
    storeId: row.store_id,
    provider: row.provider,
    channelId: row.channel_id,
    channelSecret: row.channel_secret,
    status: row.status,
  };
}

module.exports = {
  createStorePaymentAccountRepository,
};
