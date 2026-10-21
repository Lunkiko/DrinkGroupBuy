"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createMerchantRefundMarkRepository,
} = require("../backend/database/repositories/merchantRefundMarkRepository");
const {
  markOrderRefundedByMerchant,
  revokeMerchantRefundMark,
} = require("../backend/payments/merchantRefundMarkService");

const proofId = randomUUID();
const activityId = `activity-refund-mark-proof-${proofId}`;
const orderIdMain = `order-refund-mark-main-${proofId}`;
const orderIdRace = `order-refund-mark-race-${proofId}`;
const orderIdWindow = `order-refund-mark-window-${proofId}`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL merchant refund mark smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const merchantRefundMarkRepository = createMerchantRefundMarkRepository({ runtime: "postgres", database });
  try {
    const { merchantUserId } = await createFixture(database);
    const merchantUser = { id: merchantUserId, roles: ["merchant"], merchantStores: [{ id: "store-001" }] };

    // 1. A merchant marks their own store's order refunded; the active total is now queryable.
    const firstKey = `refund-mark-key-${proofId}-1`;
    const marked = await markOrderRefundedByMerchant({
      authUser: merchantUser,
      orderId: orderIdMain,
      body: { amount: 40, reason: "postgres_proof_partial", idempotencyKey: firstKey },
      merchantRefundMarkRepository,
    });
    assert.equal(marked.refundMark.status, "active");
    assert.equal(marked.idempotent, false);
    const activeAfterFirst = await merchantRefundMarkRepository.getActiveRefundTotalForOrder({ orderId: orderIdMain });
    assert.equal(activeAfterFirst, 40);

    // 2. The same key again returns the first mark, not a second one.
    const repeat = await markOrderRefundedByMerchant({
      authUser: merchantUser,
      orderId: orderIdMain,
      body: { amount: 40, reason: "postgres_proof_partial", idempotencyKey: firstKey },
      merchantRefundMarkRepository,
    });
    assert.equal(repeat.idempotent, true);
    assert.equal(repeat.refundMark.id, marked.refundMark.id);
    const markCountAfterRepeat = await database.query(
      "SELECT COUNT(*)::integer AS count FROM merchant_refund_marks WHERE order_id = $1", [orderIdMain]
    );
    assert.equal(markCountAfterRepeat.rows[0].count, 1, "a repeated key must not create a second mark");

    // 3. The cap: order final_amount is 90, 40 is already active, so 51 is refused.
    let overCapError = null;
    try {
      await markOrderRefundedByMerchant({
        authUser: merchantUser,
        orderId: orderIdMain,
        body: { amount: 51, reason: "postgres_proof_over_cap", idempotencyKey: `${proofId}-over-cap` },
        merchantRefundMarkRepository,
      });
    } catch (error) {
      overCapError = error;
    }
    assert.ok(overCapError, "marking above the remaining refundable amount should throw");
    assert.equal(overCapError.payload?.status, "refund_amount_exceeds_remaining_amount");
    assert.equal(overCapError.payload?.remainingRefundableAmount, 50);
    assert.equal(overCapError.payload?.error, "amount exceeds the order's remaining refundable amount",
      "the human message must not be clobbered by the raw status code");

    // 4. A merchant of another store cannot mark this store's order.
    let otherStoreError = null;
    try {
      await markOrderRefundedByMerchant({
        authUser: { ...merchantUser, merchantStores: [{ id: "store-not-this-one" }] },
        orderId: orderIdMain,
        body: { amount: 10, reason: "postgres_proof_wrong_store", idempotencyKey: `${proofId}-wrong-store` },
        merchantRefundMarkRepository,
      });
    } catch (error) {
      otherStoreError = error;
    }
    assert.equal(otherStoreError?.statusCode, 403);

    // 5. Marking exactly what's left, then revoking it, brings the active total back to 40.
    const secondMark = await markOrderRefundedByMerchant({
      authUser: merchantUser,
      orderId: orderIdMain,
      body: { amount: 50, reason: "postgres_proof_rest", idempotencyKey: `${proofId}-rest` },
      merchantRefundMarkRepository,
    });
    assert.equal(await merchantRefundMarkRepository.getActiveRefundTotalForOrder({ orderId: orderIdMain }), 90);

    const revoked = await revokeMerchantRefundMark({
      authUser: merchantUser,
      orderId: orderIdMain,
      markId: secondMark.refundMark.id,
      merchantRefundMarkRepository,
    });
    assert.equal(revoked.refundMark.status, "revoked");
    assert.equal(revoked.alreadyRevoked, false);
    assert.equal(await merchantRefundMarkRepository.getActiveRefundTotalForOrder({ orderId: orderIdMain }), 40);

    // 6. Only the merchant who marked it can revoke it.
    const thirdKey = `${proofId}-third`;
    const thirdMark = await markOrderRefundedByMerchant({
      authUser: merchantUser,
      orderId: orderIdMain,
      body: { amount: 5, reason: "postgres_proof_owner_check", idempotencyKey: thirdKey },
      merchantRefundMarkRepository,
    });
    let notOwnerError = null;
    try {
      await revokeMerchantRefundMark({
        authUser: { id: "user-not-the-marker", roles: ["merchant"], merchantStores: [{ id: "store-001" }] },
        orderId: orderIdMain,
        markId: thirdMark.refundMark.id,
        merchantRefundMarkRepository,
      });
    } catch (error) {
      notOwnerError = error;
    }
    assert.equal(notOwnerError?.statusCode, 403);
    assert.equal(notOwnerError?.payload?.status, "not_mark_owner");

    // 7. A mark created more than 24h ago can no longer be revoked.
    const past = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const windowKey = `${proofId}-window`;
    const windowMarkResult = await merchantRefundMarkRepository.createRefundMark({
      orderId: orderIdWindow, storeId: "store-001", amount: 10, reason: "postgres_proof_window",
      idempotencyKey: windowKey, actorUserId: merchantUserId, now: past
    });
    assert.ok(windowMarkResult.refundMark, "window-test mark should be created");
    let windowExpiredError = null;
    try {
      await revokeMerchantRefundMark({
        authUser: merchantUser,
        orderId: orderIdWindow,
        markId: windowMarkResult.refundMark.id,
        merchantRefundMarkRepository,
      });
    } catch (error) {
      windowExpiredError = error;
    }
    assert.equal(windowExpiredError?.statusCode, 409);
    assert.equal(windowExpiredError?.payload?.status, "revoke_window_expired");

    // 8. Concurrency: two simultaneous marks whose amounts together exceed final_amount (70) must
    // not both succeed -- this is what actually proves the orders-row FOR UPDATE lock in
    // createRefundMarkPostgres serializes concurrent writers, not just that the SQL parses.
    const raceDatabaseA = createRuntimeDatabaseAdapter({ runtime: "postgres" });
    const raceDatabaseB = createRuntimeDatabaseAdapter({ runtime: "postgres" });
    const raceRepoA = createMerchantRefundMarkRepository({ runtime: "postgres", database: raceDatabaseA });
    const raceRepoB = createMerchantRefundMarkRepository({ runtime: "postgres", database: raceDatabaseB });
    try {
      const [resultA, resultB] = await Promise.all([
        raceRepoA.createRefundMark({
          orderId: orderIdRace, storeId: "store-001", amount: 40, reason: "race-a",
          idempotencyKey: `${proofId}-race-a`, actorUserId: merchantUserId
        }),
        raceRepoB.createRefundMark({
          orderId: orderIdRace, storeId: "store-001", amount: 40, reason: "race-b",
          idempotencyKey: `${proofId}-race-b`, actorUserId: merchantUserId
        }),
      ]);
      const succeeded = [resultA, resultB].filter((r) => !r.error);
      const failed = [resultA, resultB].filter((r) => r.error);
      assert.equal(succeeded.length, 1, "exactly one of the two concurrent 40+40-over-70 marks must succeed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].error, "refund_amount_exceeds_remaining_amount");
      const raceActiveTotal = await merchantRefundMarkRepository.getActiveRefundTotalForOrder({ orderId: orderIdRace });
      assert.equal(raceActiveTotal, 40, "the order's active total must reflect only the one mark that actually won");
    } finally {
      await raceDatabaseA.close();
      await raceDatabaseB.close();
    }

    console.log("PostgreSQL merchant refund mark create/idempotency/cap/ownership/window/concurrency proof passed.");
  } finally {
    await cleanup(database);
    await database.close();
  }
}

async function createFixture(database) {
  const merchantResult = await database.query(`
    SELECT user_id FROM merchant_users
    WHERE store_id = 'store-001' AND status = 'active'
    LIMIT 1
  `);
  // Three distinct customers: idx_orders_one_active_per_customer_activity allows only one active
  // order per (activity, customer), and all three fixture orders share one activity.
  const customersResult = await database.query(`
    SELECT user_account.id
    FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'customer' AND user_role.status = 'active' AND user_account.status = 'active'
    ORDER BY user_account.id
    LIMIT 3
  `);
  assert.equal(customersResult.rows.length, 3, "Three active PostgreSQL customers are required");
  const merchantUserId = merchantResult.rows[0].user_id;

  const now = new Date();
  const start = new Date(now.getTime() - 90 * 60_000);
  const deadline = new Date(now.getTime() - 60 * 60_000);
  const pickupStart = new Date(now.getTime() - 30 * 60_000);
  const pickupEnd = new Date(now.getTime() + 60 * 60_000);

  await database.transaction(async (transaction) => {
    await transaction.query(`
      INSERT INTO group_buy_activities (
        id, store_id, created_by_user_id, title, status,
        start_at, deadline_at, pickup_start_at, pickup_end_at,
        maximum_cups, withdrawal_lock_minutes, created_at, updated_at
      ) VALUES ($1, 'store-001', $2, 'PostgreSQL Refund Mark Proof', 'ready_for_pickup',
                $3, $4, $5, $6, 3, 30, $4, $4)
    `, [activityId, merchantUserId, start.toISOString(), deadline.toISOString(),
      pickupStart.toISOString(), pickupEnd.toISOString()]);

    const orders = [
      { id: orderIdMain, amount: 90, customerId: customersResult.rows[0].id },
      { id: orderIdRace, amount: 70, customerId: customersResult.rows[1].id },
      { id: orderIdWindow, amount: 20, customerId: customersResult.rows[2].id },
    ];
    for (const order of orders) {
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference,
          total_cups, original_amount, final_amount, payment_status,
          authorization_status, merchant_acceptance_status, pickup_status,
          submitted_at, updated_at
        ) VALUES ($1, $2, $3, 'submitted', 'decline_original_price',
                  1, $4, $4, 'captured', 'captured', 'accepted', 'not_ready', $5, $5)
      `, [order.id, activityId, order.customerId, order.amount, now.toISOString()]);

      const authorizationId = `payment-authorization-refund-mark-proof-${order.id}`;
      await transaction.query(`
        INSERT INTO payment_authorizations (
          id, order_id, provider, payment_flow, status,
          original_amount, authorized_amount, provider_authorization_id,
          authorized_at, created_at, updated_at
        ) VALUES ($1, $2, 'mock_line_pay', 'authorization', 'captured',
                  $3, $3, $4, $5, $5, $5)
      `, [authorizationId, order.id, order.amount, `mock-txn-${order.id}`, now.toISOString()]);

      const captureId = `payment-capture-refund-mark-proof-${order.id}`;
      await transaction.query(`
        INSERT INTO payment_captures (
          id, payment_authorization_id, order_id, status,
          final_amount, capture_amount, released_amount,
          captured_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'captured', $4, $4, 0, $5, $5, $5)
      `, [captureId, authorizationId, order.id, order.amount, now.toISOString()]);
    }
  });

  return { merchantUserId };
}

async function cleanup(database) {
  const orderIds = [orderIdMain, orderIdRace, orderIdWindow];
  await database.transaction(async (transaction) => {
    await transaction.query(
      "DELETE FROM audit_logs WHERE resource_type = 'merchant_refund_mark' AND resource_id IN "
      + "(SELECT id FROM merchant_refund_marks WHERE order_id = ANY($1::text[]))", [orderIds]
    );
    await transaction.query("DELETE FROM merchant_refund_marks WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM payment_captures WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM payment_authorizations WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = $1", [activityId]);
  });
}

main().catch((error) => {
  console.error("Merchant refund mark PostgreSQL smoke failed:", error);
  process.exitCode = 1;
});
