"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const { createOrderRevisionRepository } = require("../backend/database/repositories/orderRevisionRepository");
const {
  createPaymentAuthorizationRequestRepository,
} = require("../backend/database/repositories/paymentAuthorizationRequestRepository");
const {
  createPaymentAuthorizationConfirmRepository,
} = require("../backend/database/repositories/paymentAuthorizationConfirmRepository");
const {
  createPaymentAuthorizationCancelRepository,
} = require("../backend/database/repositories/paymentAuthorizationCancelRepository");

const proofId = randomUUID();
const activityIdA = `activity-revision-apply-${proofId}`;
const activityIdB = `activity-revision-reject-${proofId}`;
const activityIdC = `activity-revision-cancel-${proofId}`;
const activityIdD = `activity-revision-boundary-${proofId}`;
const orderIdA = `order-revision-apply-${proofId}`;
const orderIdB1 = `order-revision-reject-1-${proofId}`;
const orderIdB2 = `order-revision-reject-2-${proofId}`;
const orderIdC = `order-revision-cancel-${proofId}`;
const orderIdD = `order-revision-boundary-own-${proofId}`;
const orderIdDFiller = `order-revision-boundary-filler-${proofId}`;

const DRINK_ITEM = {
  menuItemId: "drink-001",
  quantity: 2,
  customizationOptionIds: [
    "drink-001-opt-size-medium",
    "drink-001-opt-sweet-regular",
    "drink-001-opt-ice-regular",
  ],
};

function items(quantity) {
  return [{ ...DRINK_ITEM, quantity }];
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL order revision smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const orderRevisionRepository = createOrderRevisionRepository({ runtime: "postgres", database });
  const requestRepository = createPaymentAuthorizationRequestRepository({ runtime: "postgres", database });
  const confirmRepository = createPaymentAuthorizationConfirmRepository({ runtime: "postgres", database });
  const cancelRepository = createPaymentAuthorizationCancelRepository({ runtime: "postgres", database });

  try {
    const fixture = await createFixture(database);

    // --- Scenario A: create -> request -> confirm -> revision applied. ---
    const createdA = await orderRevisionRepository.createRevision({
      orderId: orderIdA,
      customerUserId: fixture.customerA,
      items: items(3),
    });
    assert.ok(createdA.revision, "revision A should be created");
    assert.equal(createdA.revision.status, "pending_authorization");
    assert.equal(createdA.revision.totalCups, 3);
    assert.equal(createdA.revision.originalAmount, 195);
    assert.equal(createdA.revision.previousTotalCups, 2);
    assert.equal(createdA.revision.previousOriginalAmount, 130);
    assert.equal(createdA.revision.items.length, 1);
    assert.equal(createdA.revision.items[0].quantity, 3);

    const pendingA = await requestRepository.createPendingAuthorization({
      orderRevisionId: createdA.revision.id,
      amount: 195,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-apply-${proofId}`,
    });
    assert.ok(pendingA, "pending authorization for revision A should be created");
    assert.equal(pendingA.status, "pending");
    assert.equal(pendingA.orderRevisionId, createdA.revision.id);
    assert.equal(pendingA.originalAmount, 195, "authorization amount should follow the revision, not the order");

    const confirmedA = await confirmRepository.confirmAuthorization({
      orderId: orderIdA,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-apply-${proofId}`,
      amount: 195,
    });
    assert.equal(confirmedA.status, "authorized");
    assert.equal(confirmedA.orderRevisionId, createdA.revision.id);
    assert.ok(confirmedA.appliedOrderRevision, "confirm result should include the applied revision");
    assert.equal(confirmedA.appliedOrderRevision.status, "applied");
    assert.equal(confirmedA.appliedOrderRevision.replacementPaymentAuthorizationId, confirmedA.id);
    assert.ok(confirmedA.replacedAuthorization, "confirm result should include the replaced authorization");
    assert.equal(confirmedA.replacedAuthorization.id, fixture.authIdA);

    const orderAAfter = await database.query(`
      SELECT total_cups, original_amount, final_amount, payment_status, authorization_status,
             merchant_acceptance_status, pickup_status
      FROM orders WHERE id = $1
    `, [orderIdA]);
    assert.deepEqual(orderAAfter.rows[0], {
      total_cups: 3,
      original_amount: 195,
      final_amount: null,
      payment_status: "authorized",
      authorization_status: "authorized",
      merchant_acceptance_status: "accepted",
      pickup_status: "not_ready",
    });
    const orderAItems = await database.query(`
      SELECT quantity, unit_price_snapshot, subtotal FROM order_items WHERE order_id = $1
    `, [orderIdA]);
    assert.equal(orderAItems.rows.length, 1, "old order items must be replaced, not appended");
    assert.deepEqual(
      { quantity: orderAItems.rows[0].quantity, subtotal: orderAItems.rows[0].subtotal },
      { quantity: 3, subtotal: 195 }
    );

    // Idempotent re-confirm (e.g. a duplicate webhook) must return the already-authorized
    // state, not re-apply the revision a second time.
    const reconfirmedA = await confirmRepository.confirmAuthorization({
      orderId: orderIdA,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-apply-${proofId}`,
      amount: 195,
    });
    assert.equal(reconfirmedA.status, "authorized");
    assert.equal(reconfirmedA.id, confirmedA.id);

    // --- Scenario B: capacity exceeded at confirm time -> revision marked failed. ---
    const createdB = await orderRevisionRepository.createRevision({
      orderId: orderIdB1,
      customerUserId: fixture.customerB1,
      items: items(3),
    });
    assert.ok(createdB.revision, "revision B should be created (capacity was fine at create time)");

    const pendingB = await requestRepository.createPendingAuthorization({
      orderRevisionId: createdB.revision.id,
      amount: 195,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-reject-${proofId}`,
    });
    assert.equal(pendingB.status, "pending");

    // Simulate a second order consuming capacity between revision-create and confirm.
    await insertAuthorizedOrder(database, {
      orderId: orderIdB2,
      activityId: activityIdB,
      customerUserId: fixture.customerB2,
      totalCups: 2,
      amount: 130,
      authorizationId: `payment-authorization-revision-reject-2-${proofId}`,
    });

    const confirmedB = await confirmRepository.confirmAuthorization({
      orderId: orderIdB1,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-reject-${proofId}`,
      amount: 195,
    });
    assert.equal(confirmedB.error, "capacity_exceeded");
    assert.equal(confirmedB.authorizedCups, 2);
    assert.equal(confirmedB.requestedCups, 3);
    assert.equal(confirmedB.maximumCups, 4);

    const revisionBAfter = await database.query(`
      SELECT status, failure_reason FROM order_revisions WHERE id = $1
    `, [createdB.revision.id]);
    assert.equal(revisionBAfter.rows[0].status, "failed");
    assert.equal(revisionBAfter.rows[0].failure_reason, "capacity_exceeded_at_confirm");
    const orderB1Unchanged = await database.query(`
      SELECT total_cups, original_amount, payment_status FROM orders WHERE id = $1
    `, [orderIdB1]);
    assert.deepEqual(orderB1Unchanged.rows[0], { total_cups: 2, original_amount: 130, payment_status: "authorized" });

    // --- Scenario C: cancel a pending revision authorization -> revision marked failed. ---
    const createdC = await orderRevisionRepository.createRevision({
      orderId: orderIdC,
      customerUserId: fixture.customerC,
      items: items(3),
    });
    const pendingC = await requestRepository.createPendingAuthorization({
      orderRevisionId: createdC.revision.id,
      amount: 195,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-cancel-${proofId}`,
    });
    assert.equal(pendingC.status, "pending");

    const cancelledC = await cancelRepository.cancelPendingAuthorization({
      orderId: orderIdC,
      provider: "mock_line_pay",
    });
    assert.equal(cancelledC.status, "failed");
    assert.equal(cancelledC.orderRevisionId, createdC.revision.id);

    const revisionCAfter = await database.query(`
      SELECT status, failure_reason FROM order_revisions WHERE id = $1
    `, [createdC.revision.id]);
    assert.equal(revisionCAfter.rows[0].status, "failed");
    assert.equal(revisionCAfter.rows[0].failure_reason, "line_pay_cancel_redirect");

    // The original order's own authorization must be untouched by the revision cancellation.
    const orderCUnchanged = await database.query(`
      SELECT total_cups, original_amount, payment_status FROM orders WHERE id = $1
    `, [orderIdC]);
    assert.deepEqual(orderCUnchanged.rows[0], { total_cups: 2, original_amount: 130, payment_status: "authorized" });

    // --- Scenario D: exact-boundary success. Activity capped at 30 cups, a filler order
    // already holds 27 (unrelated to the customer's own order), and the customer's own order
    // goes from 2 -> 3 cups. The capacity check must exclude the order's OWN existing cups
    // from the "already authorized" baseline before re-adding the new total, or this would be
    // wrongly rejected as double-counting (27 + 2 + 3 = 32 > 30) instead of correctly landing
    // exactly on the cap (27 + 3 = 30). This mirrors a real reported scenario: activity shows
    // 29/30, the customer's own order is already 2 of those 29, they want to bump it to 3.
    const createdD = await orderRevisionRepository.createRevision({
      orderId: orderIdD,
      customerUserId: fixture.customerD,
      items: items(3),
    });
    assert.ok(createdD.revision, "revision D should be created: 27 (others) + 3 (new total) = 30, exactly at cap");

    const pendingD = await requestRepository.createPendingAuthorization({
      orderRevisionId: createdD.revision.id,
      amount: 195,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-boundary-${proofId}`,
    });
    assert.equal(pendingD.status, "pending");

    const confirmedD = await confirmRepository.confirmAuthorization({
      orderId: orderIdD,
      provider: "mock_line_pay",
      providerTransactionId: `mock-txn-revision-boundary-${proofId}`,
      amount: 195,
    });
    assert.equal(confirmedD.status, "authorized", "confirm must succeed exactly at the capacity boundary");
    assert.ok(confirmedD.appliedOrderRevision, "revision D should be applied, not rejected");
    assert.equal(confirmedD.appliedOrderRevision.status, "applied");

    const orderDAfter = await database.query(
      "SELECT total_cups, payment_status FROM orders WHERE id = $1", [orderIdD]
    );
    assert.deepEqual(orderDAfter.rows[0], { total_cups: 3, payment_status: "authorized" });

    const activityDTotal = await database.query(`
      SELECT COALESCE(SUM(total_cups), 0)::integer AS cups
      FROM orders WHERE activity_id = $1 AND payment_status IN ('authorized', 'captured') AND status != 'cancelled'
    `, [activityIdD]);
    assert.equal(activityDTotal.rows[0].cups, 30, "activity should now sit exactly at its 30-cup cap");

    // --- Scenario E: one cup past the same boundary must still be rejected. Activity D is now
    // exactly full (30/30); revising the filler order from 27 -> 28 needs 3 (order D) + 28 = 31,
    // one over the cap, and must be rejected at revision-creation time (not silently allowed).
    const rejectedE = await orderRevisionRepository.createRevision({
      orderId: orderIdDFiller,
      customerUserId: fixture.customerDFiller,
      items: items(28),
    });
    assert.equal(rejectedE.error, "capacity_exceeded");
    assert.equal(rejectedE.authorizedCups, 3);
    assert.equal(rejectedE.requestedCups, 28);
    assert.equal(rejectedE.maximumCups, 30);

    // --- Edge cases: already-pending revision, and revision not found. ---
    const duplicateAttemptC = await orderRevisionRepository.createRevision({
      orderId: orderIdC,
      customerUserId: fixture.customerC,
      items: items(4),
    });
    assert.equal(duplicateAttemptC.error, undefined, "cancelled revision must not block a fresh one");

    const notFound = await confirmRepository.confirmAuthorization({
      orderId: "nonexistent-order-does-not-exist",
      providerTransactionId: "nonexistent-transaction",
      amount: 1,
    });
    assert.equal(notFound, null);

    console.log("PostgreSQL order revision create/request/confirm/reject/cancel proof passed.");
  } finally {
    await cleanup(database);
    await database.close();
  }
}

async function createFixture(database) {
  const customersResult = await database.query(`
    SELECT user_account.id
    FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'customer'
      AND user_role.status = 'active'
      AND user_account.status = 'active'
    ORDER BY user_account.id
    LIMIT 4
  `);
  assert.equal(customersResult.rows.length, 4, "Four active PostgreSQL customers are required");
  const [customerA, customerB1, customerB2, customerC] = customersResult.rows.map((row) => row.id);
  const merchantResult = await database.query(`
    SELECT user_id FROM merchant_users WHERE store_id = 'store-001' AND status = 'active'
  `);
  const merchantUserId = merchantResult.rows[0].user_id;

  const now = new Date();
  const start = new Date(now.getTime() - 90 * 60_000).toISOString();
  const deadline = new Date(now.getTime() + 6 * 60 * 60_000).toISOString();
  const pickupStart = new Date(now.getTime() + 7 * 60 * 60_000).toISOString();
  const pickupEnd = new Date(now.getTime() + 10 * 60 * 60_000).toISOString();

  await database.transaction(async (transaction) => {
    for (const [activityId, maximumCups] of [
      [activityIdA, 10], [activityIdB, 4], [activityIdC, 10], [activityIdD, 30],
    ]) {
      await transaction.query(`
        INSERT INTO group_buy_activities (
          id, store_id, created_by_user_id, title, status,
          start_at, deadline_at, pickup_start_at, pickup_end_at,
          maximum_cups, withdrawal_lock_minutes, created_at, updated_at
        ) VALUES ($1, 'store-001', $2, 'PostgreSQL Revision Proof', 'recruiting',
                  $3, $4, $5, $6, $7, 30, $4, $4)
      `, [activityId, merchantUserId, start, deadline, pickupStart, pickupEnd, maximumCups]);
    }

    await insertAuthorizedOrder(transaction, {
      orderId: orderIdA, activityId: activityIdA, customerUserId: customerA,
      totalCups: 2, amount: 130, authorizationId: `payment-authorization-revision-apply-${proofId}`,
    });
    await insertAuthorizedOrder(transaction, {
      orderId: orderIdB1, activityId: activityIdB, customerUserId: customerB1,
      totalCups: 2, amount: 130, authorizationId: `payment-authorization-revision-reject-1-${proofId}`,
    });
    await insertAuthorizedOrder(transaction, {
      orderId: orderIdC, activityId: activityIdC, customerUserId: customerC,
      totalCups: 2, amount: 130, authorizationId: `payment-authorization-revision-cancel-${proofId}`,
    });
    // Scenario D/E fixture: reusing customerC/customerB2 here is fine -- the "one active order
    // per customer per activity" constraint is scoped per activity, and this is a different one.
    await insertAuthorizedOrder(transaction, {
      orderId: orderIdDFiller, activityId: activityIdD, customerUserId: customerB2,
      totalCups: 27, amount: 27 * 65, authorizationId: `payment-authorization-revision-boundary-filler-${proofId}`,
    });
    await insertAuthorizedOrder(transaction, {
      orderId: orderIdD, activityId: activityIdD, customerUserId: customerC,
      totalCups: 2, amount: 130, authorizationId: `payment-authorization-revision-boundary-own-${proofId}`,
    });
  });

  return {
    customerA, customerB1, customerB2, customerC,
    customerD: customerC, customerDFiller: customerB2,
    authIdA: `payment-authorization-revision-apply-${proofId}`,
  };
}

async function insertAuthorizedOrder(database, { orderId, activityId, customerUserId, totalCups, amount, authorizationId }) {
  const now = new Date().toISOString();
  await database.query(`
    INSERT INTO orders (
      id, activity_id, customer_user_id, status, fallback_purchase_preference,
      total_cups, original_amount, payment_status, authorization_status,
      merchant_acceptance_status, pickup_status, submitted_at, updated_at
    ) VALUES ($1, $2, $3, 'submitted', 'decline_original_price', $4, $5, 'authorized', 'authorized', 'accepted', 'not_ready', $6, $6)
  `, [orderId, activityId, customerUserId, totalCups, amount, now]);
  await database.query(`
    INSERT INTO payment_authorizations (
      id, order_id, provider, payment_flow, status, original_amount, authorized_amount,
      provider_authorization_id, authorized_at, created_at, updated_at
    ) VALUES ($1, $2, 'mock_line_pay', 'authorization', 'authorized', $3, $3, $4, $5, $5, $5)
  `, [authorizationId, orderId, amount, `mock-original-txn-${orderId}`, now]);
}

async function cleanup(database) {
  const activityIds = [activityIdA, activityIdB, activityIdC, activityIdD];
  const orderIds = [orderIdA, orderIdB1, orderIdB2, orderIdC, orderIdD, orderIdDFiller];
  await database.transaction(async (transaction) => {
    await transaction.query(
      "DELETE FROM order_revision_item_customizations WHERE order_revision_item_id IN ("
      + "SELECT id FROM order_revision_items WHERE order_revision_id IN ("
      + "SELECT id FROM order_revisions WHERE order_id = ANY($1::text[])))",
      [orderIds]
    );
    await transaction.query(
      "DELETE FROM order_revision_items WHERE order_revision_id IN ("
      + "SELECT id FROM order_revisions WHERE order_id = ANY($1::text[]))",
      [orderIds]
    );
    await transaction.query(
      "DELETE FROM order_item_customizations WHERE order_item_id IN ("
      + "SELECT id FROM order_items WHERE order_id = ANY($1::text[]))",
      [orderIds]
    );
    await transaction.query("DELETE FROM order_items WHERE order_id = ANY($1::text[])", [orderIds]);
    // None of these three have an FK back to orders/payment_authorizations (resource_id is a
    // loose text reference), so they must be cleaned up explicitly or they leak as orphans.
    // Must run before payment_authorizations is deleted -- their subqueries depend on it.
    await transaction.query(
      "DELETE FROM audit_logs WHERE (resource_type = 'order' AND resource_id = ANY($1::text[])) "
      + "OR (resource_type = 'payment_authorization' AND resource_id IN "
      + "(SELECT id FROM payment_authorizations WHERE order_id = ANY($1::text[])))",
      [orderIds]
    );
    await transaction.query(
      "DELETE FROM payment_provider_events WHERE resource_type = 'authorization' AND resource_id IN "
      + "(SELECT id FROM payment_authorizations WHERE order_id = ANY($1::text[]))",
      [orderIds]
    );
    await transaction.query(
      "DELETE FROM payment_reliability_jobs WHERE resource_type = 'payment_authorization' AND resource_id IN "
      + "(SELECT id FROM payment_authorizations WHERE order_id = ANY($1::text[]))",
      [orderIds]
    );
    await transaction.query(
      "DELETE FROM status_history WHERE (resource_type = 'order' AND resource_id = ANY($1::text[])) "
      + "OR (resource_type = 'payment_authorization' AND resource_id IN "
      + "(SELECT id FROM payment_authorizations WHERE order_id = ANY($1::text[])))",
      [orderIds]
    );
    // Circular FK: payment_authorizations.order_revision_id references order_revisions, AND
    // order_revisions.original/replacement_payment_authorization_id reference payment_authorizations.
    // Break the cycle by nulling out the revisions' side before deleting either table.
    await transaction.query(
      "UPDATE order_revisions SET original_payment_authorization_id = NULL, "
      + "replacement_payment_authorization_id = NULL WHERE order_id = ANY($1::text[])",
      [orderIds]
    );
    await transaction.query("DELETE FROM payment_authorizations WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM order_revisions WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($1::text[])) AS activity_count,
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($2::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM order_revisions WHERE order_id = ANY($2::text[])) AS revision_count,
      (SELECT COUNT(*)::integer FROM payment_authorizations WHERE order_id = ANY($2::text[])) AS authorization_count,
      (SELECT COUNT(*)::integer FROM audit_logs WHERE resource_type = 'order' AND resource_id = ANY($2::text[])) AS order_audit_count
  `, [activityIds, orderIds]);
  assert.deepEqual(residue.rows[0], {
    activity_count: 0,
    order_count: 0,
    revision_count: 0,
    authorization_count: 0,
    order_audit_count: 0,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
