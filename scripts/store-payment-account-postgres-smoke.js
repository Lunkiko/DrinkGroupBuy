"use strict";

// Proves, against real PostgreSQL, that store_payment_accounts resolution picks the RIGHT store's
// credentials and never leaks another store's -- the exact failure mode the multi-channel LINE Pay
// feature exists to prevent. Builds two brand-new temporary stores so every assertion is exact.

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createStorePaymentAccountRepository,
} = require("../backend/database/repositories/storePaymentAccountRepository");
const { resolveLinePayAccountOverrides } = require("../backend/payments/linePayService");

const proofId = randomUUID();
const merchantId = `merchant-spa-proof-${proofId}`;
const storeIdA = `store-spa-proof-a-${proofId}`;
const storeIdB = `store-spa-proof-b-${proofId}`;
const storeIdNoAccount = `store-spa-proof-none-${proofId}`;
const activityId = `activity-spa-proof-${proofId}`;
const orderIdA = `order-spa-proof-a-${proofId}`;
const orderIdB = `order-spa-proof-b-${proofId}`;
const orderIdNoAccount = `order-spa-proof-none-${proofId}`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL store payment account smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createStorePaymentAccountRepository({ database });
  try {
    await createFixture(database);

    // 1. Upsert gives each store back its own row, not the other store's.
    const accountA = await repository.upsertAccount({
      storeId: storeIdA, provider: "line_pay", channelId: "channel-a", channelSecret: "secret-a",
    });
    const accountB = await repository.upsertAccount({
      storeId: storeIdB, provider: "line_pay", channelId: "channel-b", channelSecret: "secret-b",
    });
    assert.equal(accountA.channelId, "channel-a");
    assert.equal(accountB.channelId, "channel-b");

    // 2. getOrderStoreId resolves each order to its own store, not the other one's.
    assert.equal(await repository.getOrderStoreId({ orderId: orderIdA }), storeIdA);
    assert.equal(await repository.getOrderStoreId({ orderId: orderIdB }), storeIdB);

    // 3. getActiveAccountForStore never cross-leaks between stores.
    const activeA = await repository.getActiveAccountForStore({ storeId: storeIdA, provider: "line_pay" });
    const activeB = await repository.getActiveAccountForStore({ storeId: storeIdB, provider: "line_pay" });
    assert.equal(activeA.channelId, "channel-a");
    assert.equal(activeA.channelSecret, "secret-a");
    assert.equal(activeB.channelId, "channel-b");
    assert.equal(activeB.channelSecret, "secret-b");

    // 4. resolveLinePayAccountOverrides -- the function linePayService.js actually calls before
    //    every real LINE Pay request -- gives each order its own store's credentials.
    const overridesA = await resolveLinePayAccountOverrides({
      orderId: orderIdA, provider: "line_pay", storePaymentAccountRepository: repository,
    });
    const overridesB = await resolveLinePayAccountOverrides({
      orderId: orderIdB, provider: "line_pay", storePaymentAccountRepository: repository,
    });
    assert.deepEqual(overridesA, { channelId: "channel-a", channelSecret: "secret-a" });
    assert.deepEqual(overridesB, { channelId: "channel-b", channelSecret: "secret-b" });

    // 5. A store with no account row yet falls back to {} (the global env default), not an error --
    //    this is what keeps every pre-existing/未分配 store's payments working during rollout.
    const overridesNone = await resolveLinePayAccountOverrides({
      orderId: orderIdNoAccount, provider: "line_pay", storePaymentAccountRepository: repository,
    });
    assert.deepEqual(overridesNone, {});

    // 6. provider !== "line_pay" (e.g. mock_line_pay) never even queries the database -- the raw
    //    client call for that branch already skips the real HTTP request entirely.
    const overridesMock = await resolveLinePayAccountOverrides({
      orderId: orderIdA, provider: "mock_line_pay", storePaymentAccountRepository: repository,
    });
    assert.deepEqual(overridesMock, {});

    // 7. Re-running the seed upsert (same store_id+provider) updates the row instead of duplicating it.
    await repository.upsertAccount({
      storeId: storeIdA, provider: "line_pay", channelId: "channel-a-rotated", channelSecret: "secret-a-rotated",
    });
    const rotated = await repository.getActiveAccountForStore({ storeId: storeIdA, provider: "line_pay" });
    assert.equal(rotated.channelId, "channel-a-rotated");
    const countResult = await database.query(
      "SELECT COUNT(*)::integer AS count FROM store_payment_accounts WHERE store_id = $1", [storeIdA]
    );
    assert.equal(countResult.rows[0].count, 1, "upserting the same store+provider must not create a second row");

    console.log("PostgreSQL store payment account proof passed.");
  } finally {
    await cleanup(database);
    await database.close();
  }
}

async function createFixture(database) {
  const [customers, creator] = await Promise.all([
    database.query(`
      SELECT user_account.id
      FROM users user_account
      JOIN user_roles user_role ON user_role.user_id = user_account.id
      WHERE user_role.role = 'customer' AND user_role.status = 'active' AND user_account.status = 'active'
      ORDER BY user_account.id
      LIMIT 1
    `),
    database.query("SELECT user_id FROM merchant_users WHERE status = 'active' LIMIT 1"),
  ]);
  assert.ok(customers.rows[0]?.id, "An active PostgreSQL customer is required");
  assert.ok(creator.rows[0]?.user_id, "An active merchant user is required");
  const customerId = customers.rows[0].id;
  const creatorId = creator.rows[0].user_id;
  const now = new Date();
  const iso = (offsetMinutes) => new Date(now.getTime() + offsetMinutes * 60_000).toISOString();

  await database.transaction(async (transaction) => {
    await transaction.query(
      "INSERT INTO merchants (id, name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)",
      [merchantId, `SPA proof merchant ${proofId}`, iso(0)],
    );
    for (const storeId of [storeIdA, storeIdB, storeIdNoAccount]) {
      await transaction.query(`
        INSERT INTO stores (id, merchant_id, name, address, phone, business_status, latitude, longitude, created_at, updated_at)
        VALUES ($1, $2, $3, 'test address', NULL, 'closed', 24.0, 120.0, $4, $4)
      `, [storeId, merchantId, `SPA proof store ${storeId}`, iso(0)]);
    }
    await transaction.query(`
      INSERT INTO group_buy_activities (
        id, store_id, created_by_user_id, title, status,
        start_at, deadline_at, pickup_start_at, pickup_end_at,
        maximum_cups, withdrawal_lock_minutes, created_at, updated_at
      ) VALUES ($1, $2, $3, 'SPA proof activity', 'ordering', $4, $5, $6, $7, 100, 30, $4, $4)
    `, [activityId, storeIdA, creatorId, iso(-10), iso(60), iso(90), iso(150)]);
    for (const [orderId, orderStoreId] of [[orderIdA, storeIdA], [orderIdB, storeIdB], [orderIdNoAccount, storeIdNoAccount]]) {
      // Each order needs its own activity so getOrderStoreId (which joins through activity.store_id)
      // resolves to the RIGHT store -- reuse activityId only for storeIdA, create one per other store.
      const thisActivityId = orderStoreId === storeIdA ? activityId : `${activityId}-${orderStoreId}`;
      if (orderStoreId !== storeIdA) {
        await transaction.query(`
          INSERT INTO group_buy_activities (
            id, store_id, created_by_user_id, title, status,
            start_at, deadline_at, pickup_start_at, pickup_end_at,
            maximum_cups, withdrawal_lock_minutes, created_at, updated_at
          ) VALUES ($1, $2, $3, 'SPA proof activity', 'ordering', $4, $5, $6, $7, 100, 30, $4, $4)
        `, [thisActivityId, orderStoreId, creatorId, iso(-10), iso(60), iso(90), iso(150)]);
      }
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference,
          total_cups, original_amount, final_amount, payment_status,
          authorization_status, merchant_acceptance_status, pickup_status,
          submitted_at, updated_at
        ) VALUES ($1, $2, $3, 'locked', 'decline_original_price', 1, 50, 50, 'authorized',
                  'authorized', 'pending', 'not_ready', $4, $4)
      `, [orderId, thisActivityId, customerId, iso(-5)]);
    }
  });
}

async function cleanup(database) {
  const orderIds = [orderIdA, orderIdB, orderIdNoAccount];
  const activityIds = [activityId, `${activityId}-${storeIdB}`, `${activityId}-${storeIdNoAccount}`];
  const storeIds = [storeIdA, storeIdB, storeIdNoAccount];
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM store_payment_accounts WHERE store_id = ANY($1::text[])", [storeIds]);
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
    await transaction.query("DELETE FROM stores WHERE id = ANY($1::text[])", [storeIds]);
    await transaction.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM store_payment_accounts WHERE store_id = ANY($1::text[])) AS account_count,
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($2::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($3::text[])) AS activity_count,
      (SELECT COUNT(*)::integer FROM stores WHERE id = ANY($1::text[])) AS store_count,
      (SELECT COUNT(*)::integer FROM merchants WHERE id = $4) AS merchant_count
  `, [storeIds, orderIds, activityIds, merchantId]);
  assert.deepEqual(residue.rows[0], {
    account_count: 0, order_count: 0, activity_count: 0, store_count: 0, merchant_count: 0,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
