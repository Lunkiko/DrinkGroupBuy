"use strict";

// Proves, against real PostgreSQL, which orders count toward a customer's "money saved" total.
// The fake-database unit test only checks the SQL text; this checks what the SQL actually does.
// Assertions compare before/after DELTAS so pre-existing local orders can't skew the result, and
// only rows created here (unique ids) are inserted and deleted.

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createCustomerSavingsRepository,
} = require("../backend/database/repositories/customerSavingsRepository");

const proofId = randomUUID();

// Each non-cancelled order needs its own activity: orders has a unique index on
// (activity_id, customer_user_id) WHERE status != 'cancelled'.
const orderFixtures = [
  { key: "picked-up-discounted", status: "completed", payment: "captured", pickup: "picked_up", cups: 3, original: 195, final: 137 },
  { key: "ready-discounted", status: "locked", payment: "captured", pickup: "ready", cups: 2, original: 130, final: 104 },
  { key: "not-ready-discounted", status: "locked", payment: "captured", pickup: "not_ready", cups: 1, original: 65, final: 46 },
  // A partial mark is deliberately NOT subtracted from savings (a refund compensates for a
  // problem, it isn't a change to the group-buy discount) -- this order must still count in full.
  { key: "partially-refunded-via-mark", status: "completed", payment: "captured", pickup: "picked_up", cups: 1, original: 65, final: 46, refundMarkAmount: 20 },
  // Everything below must NOT count.
  { key: "captured-no-discount", status: "locked", payment: "captured", pickup: "not_ready", cups: 1, original: 65, final: 65 },
  { key: "expired-unclaimed", status: "completed", payment: "captured", pickup: "expired", cups: 1, original: 65, final: 46 },
  { key: "fully-refunded", status: "completed", payment: "refunded", pickup: "picked_up", cups: 1, original: 65, final: 46 },
  // Scheme B (2026-10-21): payment_status never flips to 'refunded' for a self-reported refund, so
  // a fully-marked order must be excluded via the active-mark-total check instead.
  { key: "fully-refunded-via-mark", status: "completed", payment: "captured", pickup: "picked_up", cups: 1, original: 65, final: 46, refundMarkAmount: 46 },
  { key: "cancelled-but-captured", status: "cancelled", payment: "captured", pickup: "cancelled", cups: 1, original: 65, final: 46 },
  { key: "authorized-not-settled", status: "submitted", payment: "authorized", pickup: "not_ready", cups: 1, original: 65, final: null },
  { key: "authorization-voided", status: "cancelled", payment: "authorization_voided", pickup: "cancelled", cups: 1, original: 65, final: null },
  // An admin cancel leaves captured orders untouched, but the drinks can never be picked up.
  { key: "activity-cancelled", activityStatus: "cancelled", status: "locked", payment: "captured", pickup: "not_ready", cups: 1, original: 65, final: 46 },
].map((fixture) => ({
  ...fixture,
  orderId: `order-savings-proof-${fixture.key}-${proofId}`,
  activityId: `activity-savings-proof-${fixture.key}-${proofId}`,
}));

// 195-137 + 130-104 + 65-46 (not-ready) + 65-46 (partially-refunded-via-mark) = 58 + 26 + 19 + 19;
// cups 3 + 2 + 1 + 1; four orders.
const expectedDelta = { totalSavedAmount: 122, savedOrderCount: 4, savedCupCount: 7 };

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL customer savings smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createCustomerSavingsRepository({ database });
  try {
    const { customerId, otherCustomerId, merchantUserId } = await pickUsers(database);
    const before = await repository.getSavingsSummary(customerId);
    const otherBefore = await repository.getSavingsSummary(otherCustomerId);

    await createFixture(database, { customerId, merchantUserId });

    const after = await repository.getSavingsSummary(customerId);
    assert.deepEqual(
      {
        totalSavedAmount: after.totalSavedAmount - before.totalSavedAmount,
        savedOrderCount: after.savedOrderCount - before.savedOrderCount,
        savedCupCount: after.savedCupCount - before.savedCupCount,
      },
      expectedDelta,
    );

    // Another customer's totals must not move when this customer's orders change.
    assert.deepEqual(await repository.getSavingsSummary(otherCustomerId), otherBefore);

    // A customer id with no orders at all gets zeros, not an error or null.
    assert.deepEqual(
      await repository.getSavingsSummary(`customer-without-orders-${proofId}`),
      { totalSavedAmount: 0, savedOrderCount: 0, savedCupCount: 0 },
    );
    console.log("PostgreSQL customer savings proof passed.");
  } finally {
    await cleanup(database);
    await database.close();
  }
}

async function pickUsers(database) {
  const [customers, merchant] = await Promise.all([
    database.query(`
      SELECT user_account.id
      FROM users user_account
      JOIN user_roles user_role ON user_role.user_id = user_account.id
      WHERE user_role.role = 'customer'
        AND user_role.status = 'active'
        AND user_account.status = 'active'
      ORDER BY user_account.id
      LIMIT 2
    `),
    database.query(`
      SELECT user_id FROM merchant_users
      WHERE store_id = 'store-001' AND status = 'active'
      LIMIT 1
    `),
  ]);
  assert.equal(customers.rows.length, 2, "Two active PostgreSQL customers are required");
  assert.ok(merchant.rows[0]?.user_id, "An active store-001 merchant is required");
  return {
    customerId: customers.rows[0].id,
    otherCustomerId: customers.rows[1].id,
    merchantUserId: merchant.rows[0].user_id,
  };
}

async function createFixture(database, { customerId, merchantUserId }) {
  const now = new Date();
  const iso = (offsetMinutes) => new Date(now.getTime() + offsetMinutes * 60_000).toISOString();
  // Deadlines stay in the future on purpose: a running backend's deadline-settlement scheduler
  // would otherwise settle these fake activities mid-run, and the settlement rows it writes would
  // block the cleanup below (activity_settlements references group_buy_activities).
  await database.transaction(async (transaction) => {
    for (const fixture of orderFixtures) {
      await transaction.query(`
        INSERT INTO group_buy_activities (
          id, store_id, created_by_user_id, title, status,
          start_at, deadline_at, pickup_start_at, pickup_end_at,
          maximum_cups, withdrawal_lock_minutes, created_at, updated_at
        ) VALUES ($1, 'store-001', $2, $3, $8, $4, $5, $6, $7, 10, 30, $4, $4)
      `, [fixture.activityId, merchantUserId, `Savings proof ${fixture.key}`,
        iso(-120), iso(30), iso(60), iso(120), fixture.activityStatus || "ordering"]);
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference,
          total_cups, original_amount, final_amount, payment_status,
          authorization_status, merchant_acceptance_status, pickup_status,
          submitted_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'decline_original_price', $5, $6, $7, $8,
                  'authorized', 'accepted', $9, $10, $10)
      `, [fixture.orderId, fixture.activityId, customerId, fixture.status, fixture.cups,
        fixture.original, fixture.final, fixture.payment, fixture.pickup, iso(-90)]);
      if (fixture.refundMarkAmount) {
        await transaction.query(`
          INSERT INTO merchant_refund_marks (
            id, order_id, store_id, marked_by_user_id, amount, reason, status,
            idempotency_key, created_at, updated_at
          ) VALUES ($1, $2, 'store-001', $3, $4, 'savings proof', 'active', $5, $6, $6)
        `, [`refund-mark-savings-proof-${fixture.key}-${proofId}`, fixture.orderId, merchantUserId,
          fixture.refundMarkAmount, `refund-mark-key-savings-proof-${fixture.key}-${proofId}`, iso(-10)]);
      }
    }
  });
}

async function cleanup(database) {
  const orderIds = orderFixtures.map((fixture) => fixture.orderId);
  const activityIds = orderFixtures.map((fixture) => fixture.activityId);
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM merchant_refund_marks WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM activity_settlements WHERE activity_id = ANY($1::text[])", [activityIds]);
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($1::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($2::text[])) AS activity_count
  `, [orderIds, activityIds]);
  assert.deepEqual(residue.rows[0], { order_count: 0, activity_count: 0 });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
