"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createPaymentRefundRepository,
} = require("../backend/database/repositories/paymentRefundRepository");
const { refundLinePayPayment } = require("../backend/payments/linePayService");
const {
  approveRefundRequest,
  createMerchantRefundRequest,
  rejectRefundRequest,
} = require("../backend/payments/refundRequestService");

// Scheme B's merchant_refund_marks (self-reported refund, no provider call) has its own smoke
// test -- see merchant-refund-mark-postgres-smoke.js -- rather than this file, which covers the
// admin/provider-calling refund paths that are still live (direct admin refund, the merchant
// request + admin approve/reject workflow).
const proofId = randomUUID();
const activityId = `activity-refund-proof-${proofId}`;
const orderIdDirect = `order-refund-direct-${proofId}`;
const orderIdApprove = `order-refund-approve-${proofId}`;
const orderIdReject = `order-refund-reject-${proofId}`;
// Its own activity (not the shared one above) so it can reuse an existing customer without
// tripping idx_orders_one_active_per_customer_activity (one active order per customer per activity).
const activityIdCrossSource = `activity-refund-cross-source-proof-${proofId}`;
const orderIdCrossSource = `order-refund-cross-source-${proofId}`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL payment refund smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const paymentRefundRepository = createPaymentRefundRepository({ runtime: "postgres", database });
  // audit_logs.actor_user_id has a real FK to users(id), so this must be a seeded user, not a
  // synthetic proof-scoped id like the order/activity fixtures below.
  const adminUserResult = await database.query(`
    SELECT user_account.id
    FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'admin' AND user_role.status = 'active' AND user_account.status = 'active'
    LIMIT 1
  `);
  assert.ok(adminUserResult.rows[0], "An active PostgreSQL admin user is required");
  const adminUser = { id: adminUserResult.rows[0].id, roles: ["admin"] };
  try {
    const fixture = await createFixture(database);

    // 1. Direct admin refund (POST /api/payments/line-pay/refund equivalent): full refund.
    const directResult = await refundLinePayPayment({
      authUser: adminUser,
      body: { orderId: orderIdDirect, provider: "mock_line_pay", reason: "postgres_proof_full_refund" },
      paymentRefundRepository,
    });
    assert.equal(directResult.status, "refunded");
    assert.equal(directResult.refund.refundAmount, 80);
    assert.equal(directResult.fullyRefunded, true);
    assert.equal(directResult.remainingRefundableAmount, 0);
    assert.equal(directResult.order.id, orderIdDirect, "buildRefundResult's simplified order projection should still resolve");

    const orderDirectAfter = await database.query("SELECT payment_status FROM orders WHERE id = $1", [orderIdDirect]);
    assert.equal(orderDirectAfter.rows[0].payment_status, "refunded");

    // 2. Idempotency: retrying the exact same logical refund must not double-refund.
    const directRetry = await refundLinePayPayment({
      authUser: adminUser,
      body: {
        orderId: orderIdDirect,
        provider: "mock_line_pay",
        reason: "postgres_proof_full_refund",
        idempotencyKey: directResult.refund.idempotencyKey,
      },
      paymentRefundRepository,
    });
    assert.equal(directRetry.idempotent, true);
    assert.equal(directRetry.refund.id, directResult.refund.id);

    // 3. Over-refund protection: a second, independent refund attempt against the same
    // already-fully-refunded capture must be rejected, not silently accepted.
    let overRefundError = null;
    try {
      await refundLinePayPayment({
        authUser: adminUser,
        body: { orderId: orderIdDirect, provider: "mock_line_pay", refundAmount: 1 },
        paymentRefundRepository,
      });
    } catch (error) {
      overRefundError = error;
    }
    assert.ok(overRefundError, "refunding an already-fully-refunded capture should throw");
    assert.equal(overRefundError.payload?.status, "already_fully_refunded");

    // 4. Operation lock: hold the order's payment-lifecycle lock, confirm refund fails fast
    // instead of racing the lock holder (same lock namespace capture/cancel already share).
    const lockKey = `order:${orderIdApprove}:payment-lifecycle`;
    const lockOwner = `test-lock-holder-${proofId}`;
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    const lockNow = new Date().toISOString();
    await database.query(`
      INSERT INTO operation_locks (lock_key, owner_id, locked_until, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
    `, [lockKey, lockOwner, farFuture, lockNow]);
    let lockedError = null;
    try {
      await refundLinePayPayment({
        authUser: adminUser,
        body: { orderId: orderIdApprove, provider: "mock_line_pay" },
        paymentRefundRepository,
      });
    } catch (error) {
      lockedError = error;
    }
    assert.ok(lockedError, "refund should fail fast while the order's payment lock is held");
    assert.equal(lockedError.payload?.status, "retry_later");
    await database.query(
      "DELETE FROM operation_locks WHERE lock_key = $1 AND owner_id = $2", [lockKey, lockOwner]
    );

    // 5. Merchant refund-request workflow: create -> approve, ends up calling the same
    // refund-execution path as the direct route above (partial refund this time).
    const merchantUser = {
      id: fixture.merchantUserId,
      roles: ["merchant"],
      merchantStores: [{ id: "store-001" }],
    };
    const createdRequest = await createMerchantRefundRequest({
      authUser: merchantUser,
      orderId: orderIdApprove,
      body: { requestedAmount: 30, reason: "postgres_proof_partial_refund" },
      paymentRefundRepository,
    });
    assert.equal(createdRequest.refundRequest.status, "pending");
    assert.equal(createdRequest.refundRequest.requestedAmount, 30);

    const approved = await approveRefundRequest({
      authUser: adminUser,
      requestId: createdRequest.refundRequest.id,
      paymentRefundRepository,
    });
    assert.equal(approved.refundRequest.status, "approved");
    assert.equal(approved.refund.status, "refunded");
    assert.equal(approved.refund.refund.refundAmount, 30);
    assert.equal(approved.refund.fullyRefunded, false, "60-cap capture with a 30 refund still has 30 remaining");
    assert.equal(approved.refundRequest.resultingPaymentRefundId, approved.refund.refund.id);

    const orderApproveAfter = await database.query("SELECT payment_status FROM orders WHERE id = $1", [orderIdApprove]);
    assert.equal(orderApproveAfter.rows[0].payment_status, "captured", "partial refund must not flip payment_status to refunded");

    // 6. Merchant refund-request workflow: create -> reject, no refund execution happens.
    const rejectableRequest = await createMerchantRefundRequest({
      authUser: merchantUser,
      orderId: orderIdReject,
      body: { requestedAmount: 20, reason: "postgres_proof_reject_me" },
      paymentRefundRepository,
    });
    const rejected = await rejectRefundRequest({
      authUser: adminUser,
      requestId: rejectableRequest.refundRequest.id,
      body: { reason: "postgres_proof_not_eligible" },
      paymentRefundRepository,
    });
    assert.equal(rejected.refundRequest.status, "rejected");
    assert.equal(rejected.refundRequest.rejectionReason, "postgres_proof_not_eligible");
    const refundsForRejectedOrder = await database.query(
      "SELECT COUNT(*)::integer AS count FROM payment_refunds WHERE order_id = $1", [orderIdReject]
    );
    assert.equal(refundsForRejectedOrder.rows[0].count, 0, "rejecting a request must not create a payment_refunds row");

    // 7. Listing: store-scoped and admin-scoped refund-request listings both see the fixture rows.
    const storeList = await paymentRefundRepository.listRefundRequestsForStore({ storeId: "store-001" });
    const storeListIds = storeList.map((item) => item.id);
    assert.ok(storeListIds.includes(createdRequest.refundRequest.id));
    assert.ok(storeListIds.includes(rejectableRequest.refundRequest.id));

    const adminApprovedList = await paymentRefundRepository.listRefundRequestsForAdmin({ status: "approved" });
    assert.ok(adminApprovedList.some((item) => item.id === createdRequest.refundRequest.id));

    // 8. Cross-source cap: order final_amount/capture_amount is 100, and a merchant_refund_mark
    // already marked 40 of it as actively refunded via the self-reported scheme-B path (which
    // never touches payment_status/payment_refunds). A direct provider refund of 70 must be
    // refused against the correctly-reduced remaining amount (60), and a refund of exactly 60
    // must succeed -- proving createPendingRefundPostgres's cap now also subtracts
    // merchant_refund_marks, not just other payment_refunds rows (2026-10-22 /code-review finding
    // on adminStatisticsRepository.js, which first surfaced this gap).
    let crossSourceOverCapError = null;
    try {
      await refundLinePayPayment({
        authUser: adminUser,
        body: { orderId: orderIdCrossSource, provider: "mock_line_pay", refundAmount: 70 },
        paymentRefundRepository,
      });
    } catch (error) {
      crossSourceOverCapError = error;
    }
    assert.equal(crossSourceOverCapError?.payload?.status, "refund_amount_exceeds_remaining_amount");
    assert.equal(crossSourceOverCapError?.payload?.remainingRefundableAmount, 60,
      "the cap must subtract the existing active merchant_refund_marks row, not just other payment_refunds rows");

    const crossSourceRefund = await refundLinePayPayment({
      authUser: adminUser,
      body: { orderId: orderIdCrossSource, provider: "mock_line_pay", refundAmount: 60 },
      paymentRefundRepository,
    });
    assert.equal(crossSourceRefund.status, "refunded");
    assert.equal(crossSourceRefund.refund.refundAmount, 60);

    console.log("PostgreSQL payment refund direct/idempotency/lock/request-workflow/cross-source proof passed.");
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
  const customersResult = await database.query(`
    SELECT user_account.id
    FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'customer'
      AND user_role.status = 'active'
      AND user_account.status = 'active'
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
      ) VALUES ($1, 'store-001', $2, 'PostgreSQL Refund Proof', 'ready_for_pickup',
                $3, $4, $5, $6, 3, 30, $4, $4)
    `, [activityId, merchantUserId, start.toISOString(), deadline.toISOString(),
      pickupStart.toISOString(), pickupEnd.toISOString()]);

    const orders = [
      { id: orderIdDirect, activityId, customerId: customersResult.rows[0].id, amount: 80 },
      { id: orderIdApprove, activityId, customerId: customersResult.rows[1].id, amount: 60 },
      { id: orderIdReject, activityId, customerId: customersResult.rows[2].id, amount: 50 },
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
      `, [order.id, order.activityId, order.customerId, order.amount, now.toISOString()]);

      const authorizationId = `payment-authorization-refund-proof-${order.id}`;
      await transaction.query(`
        INSERT INTO payment_authorizations (
          id, order_id, provider, payment_flow, status,
          original_amount, authorized_amount, provider_authorization_id,
          authorized_at, created_at, updated_at
        ) VALUES ($1, $2, 'mock_line_pay', 'authorization', 'captured',
                  $3, $3, $4, $5, $5, $5)
      `, [authorizationId, order.id, order.amount, `mock-txn-${order.id}`, now.toISOString()]);

      const captureId = `payment-capture-refund-proof-${order.id}`;
      await transaction.query(`
        INSERT INTO payment_captures (
          id, payment_authorization_id, order_id, status,
          final_amount, capture_amount, released_amount,
          captured_at, created_at, updated_at
        ) VALUES ($1, $2, $3, 'captured', $4, $4, 0, $5, $5, $5)
      `, [captureId, authorizationId, order.id, order.amount, now.toISOString()]);
    }

    // Cross-source fixture, on its own activity so it can reuse an existing customer (see the
    // constant's own comment above).
    await transaction.query(`
      INSERT INTO group_buy_activities (
        id, store_id, created_by_user_id, title, status,
        start_at, deadline_at, pickup_start_at, pickup_end_at,
        maximum_cups, withdrawal_lock_minutes, created_at, updated_at
      ) VALUES ($1, 'store-001', $2, 'PostgreSQL Refund Cross-Source Proof', 'ready_for_pickup',
                $3, $4, $5, $6, 3, 30, $4, $4)
    `, [activityIdCrossSource, merchantUserId, start.toISOString(), deadline.toISOString(),
      pickupStart.toISOString(), pickupEnd.toISOString()]);
    await transaction.query(`
      INSERT INTO orders (
        id, activity_id, customer_user_id, status, fallback_purchase_preference,
        total_cups, original_amount, final_amount, payment_status,
        authorization_status, merchant_acceptance_status, pickup_status,
        submitted_at, updated_at
      ) VALUES ($1, $2, $3, 'submitted', 'decline_original_price',
                1, 100, 100, 'captured', 'captured', 'accepted', 'not_ready', $4, $4)
    `, [orderIdCrossSource, activityIdCrossSource, customersResult.rows[0].id, now.toISOString()]);
    const crossSourceAuthorizationId = `payment-authorization-refund-cross-source-proof-${proofId}`;
    await transaction.query(`
      INSERT INTO payment_authorizations (
        id, order_id, provider, payment_flow, status,
        original_amount, authorized_amount, provider_authorization_id,
        authorized_at, created_at, updated_at
      ) VALUES ($1, $2, 'mock_line_pay', 'authorization', 'captured',
                100, 100, $3, $4, $4, $4)
    `, [crossSourceAuthorizationId, orderIdCrossSource, `mock-txn-cross-source-${proofId}`, now.toISOString()]);
    const crossSourceCaptureId = `payment-capture-refund-cross-source-proof-${proofId}`;
    await transaction.query(`
      INSERT INTO payment_captures (
        id, payment_authorization_id, order_id, status,
        final_amount, capture_amount, released_amount,
        captured_at, created_at, updated_at
      ) VALUES ($1, $2, $3, 'captured', 100, 100, 0, $4, $4, $4)
    `, [crossSourceCaptureId, crossSourceAuthorizationId, orderIdCrossSource, now.toISOString()]);
    // The merchant self-reported scheme-B path already marked 40 of this order as actively
    // refunded -- payment_status/payment_refunds are untouched by that path, exactly like a real
    // merchant-marked refund would leave them.
    await transaction.query(`
      INSERT INTO merchant_refund_marks (
        id, order_id, store_id, marked_by_user_id, amount, reason, status, idempotency_key, created_at, updated_at
      ) VALUES ($1, $2, 'store-001', $3, 40, 'postgres_proof_cross_source_mark', 'active', $4, $5, $5)
    `, [`merchant-refund-mark-cross-source-proof-${proofId}`, orderIdCrossSource, merchantUserId,
      `cross-source-mark-${proofId}`, now.toISOString()]);
  });

  return { merchantUserId };
}

async function cleanup(database) {
  const activityIds = [activityId, activityIdCrossSource];
  const orderIds = [orderIdDirect, orderIdApprove, orderIdReject, orderIdCrossSource];
  await database.transaction(async (transaction) => {
    // audit_logs.metadata_json doesn't carry orderId for every action type (approve/reject
    // don't, matching the original SQLite shape), so resolve the actual refund/request ids
    // first rather than trying to filter audit rows by order directly.
    const refundIdsResult = await transaction.query(
      "SELECT id FROM payment_refunds WHERE order_id = ANY($1::text[])", [orderIds]
    );
    const refundRequestIdsResult = await transaction.query(
      "SELECT id FROM refund_requests WHERE order_id = ANY($1::text[])", [orderIds]
    );
    const auditResourceIds = [
      ...refundIdsResult.rows.map((row) => row.id),
      ...refundRequestIdsResult.rows.map((row) => row.id),
    ];
    if (auditResourceIds.length > 0) {
      await transaction.query(
        "DELETE FROM audit_logs WHERE resource_type IN ('payment_refund', 'refund_request') "
        + "AND resource_id = ANY($1::text[])",
        [auditResourceIds]
      );
    }
    await transaction.query("DELETE FROM refund_requests WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM merchant_refund_marks WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM payment_refunds WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM payment_captures WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM payment_authorizations WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query(
      "DELETE FROM status_history WHERE resource_type = 'order' AND resource_id = ANY($1::text[])", [orderIds]
    );
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
    await transaction.query(
      "DELETE FROM operation_locks WHERE lock_key LIKE '%' || $1 || '%'", [proofId]
    );
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($1::text[])) AS activity_count,
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($2::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM payment_refunds WHERE order_id = ANY($2::text[])) AS refund_count,
      (SELECT COUNT(*)::integer FROM refund_requests WHERE order_id = ANY($2::text[])) AS refund_request_count,
      (SELECT COUNT(*)::integer FROM merchant_refund_marks WHERE order_id = ANY($2::text[])) AS refund_mark_count,
      (SELECT COUNT(*)::integer FROM operation_locks WHERE lock_key LIKE '%' || $3 || '%') AS lock_count
  `, [activityIds, orderIds, proofId]);
  assert.deepEqual(residue.rows[0], {
    activity_count: 0,
    order_count: 0,
    refund_count: 0,
    refund_request_count: 0,
    refund_mark_count: 0,
    lock_count: 0,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
