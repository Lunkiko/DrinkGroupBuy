"use strict";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createPickupCredentialRepository,
} = require("../backend/database/repositories/pickupCredentialRepository");
const {
  getPickupCredentialForOrder,
  lookupPickupCode,
  markGroupBuyActivityReadyForPickup,
  redeemPickupCode,
} = require("../backend/pickup/credentialService");

const proofId = randomUUID();
const activityId = `activity-pickup-proof-${proofId}`;
const orderIdA = `order-pickup-proof-a-${proofId}`;
const orderIdB = `order-pickup-proof-b-${proofId}`;
const expiredActivityId = `activity-pickup-expired-proof-${proofId}`;
const expiredOrderId = `order-pickup-expired-proof-${proofId}`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL pickup credential smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createPickupCredentialRepository({ runtime: "postgres", database });
  try {
    const fixture = await createFixture(database);

    // 1. Mark ready: generates two credentials, activity -> ready_for_pickup.
    const readyResult = await markGroupBuyActivityReadyForPickup(activityId, {
      actorUserId: fixture.merchantUserId,
      pickupCredentialRepository: repository,
    });
    assert.equal(readyResult.status, "ready_for_pickup");
    assert.equal(readyResult.createdCredentialCount, 2);
    assert.equal(readyResult.readyOrderCount, 2);
    assert.equal(readyResult.credentials.length, 2);

    const activityAfterReady = await database.query(
      "SELECT status FROM group_buy_activities WHERE id = $1", [activityId]
    );
    assert.equal(activityAfterReady.rows[0].status, "ready_for_pickup");

    // 2. Re-marking ready with no new captured orders is a safe no-op (0 created, 0 newly ready).
    const readyAgain = await markGroupBuyActivityReadyForPickup(activityId, {
      actorUserId: fixture.merchantUserId,
      pickupCredentialRepository: repository,
    });
    assert.equal(readyAgain.status, "ready_for_pickup");
    assert.equal(readyAgain.createdCredentialCount, 0);
    assert.equal(readyAgain.readyOrderCount, 0);

    // 3. Operation lock: hold the activity-transition lock, confirm mark-ready fails fast.
    const lockKey = `pickup:activity:${activityId}:transition`;
    const lockOwner = `test-lock-holder-${proofId}`;
    const farFuture = new Date(Date.now() + 60_000).toISOString();
    const lockNow = new Date().toISOString();
    await database.query(`
      INSERT INTO operation_locks (lock_key, owner_id, locked_until, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
    `, [lockKey, lockOwner, farFuture, lockNow]);
    const lockedAttempt = await markGroupBuyActivityReadyForPickup(activityId, {
      actorUserId: fixture.merchantUserId,
      pickupCredentialRepository: repository,
    });
    assert.equal(lockedAttempt.error, "operation_locked");
    assert.equal(lockedAttempt.lockKey, lockKey);
    await database.query(
      "DELETE FROM operation_locks WHERE lock_key = $1 AND owner_id = $2", [lockKey, lockOwner]
    );

    // 4. Customer-facing credential lookup for order A.
    const credentialForOrderA = await getPickupCredentialForOrder(orderIdA, {
      pickupCredentialRepository: repository,
    });
    assert.equal(credentialForOrderA.status, "active");
    assert.ok(credentialForOrderA.pickupCode, "active credential should expose its pickup code");

    // 4b. Cross-store protection: a merchant from a DIFFERENT store must not be able to look up
    // or redeem this code, even though it's a syntactically valid 6-digit code. The repository
    // scopes both queries through merchant_users.store_id, so this must come back as
    // "not found" (not a permission error that would leak the code's existence).
    const otherStoreLookup = await lookupPickupCode({
      actorUserId: fixture.otherStoreMerchantUserId,
      pickupCode: credentialForOrderA.pickupCode,
      pickupCredentialRepository: repository,
    });
    assert.equal(otherStoreLookup.error, "credential_not_found", "a different store's merchant must not see this code");

    const otherStoreRedeem = await redeemPickupCode({
      actorUserId: fixture.otherStoreMerchantUserId,
      pickupCode: credentialForOrderA.pickupCode,
      pickupCredentialRepository: repository,
    });
    assert.equal(otherStoreRedeem.error, "credential_not_found", "a different store's merchant must not redeem this code");
    const orderANotRedeemedByOtherStore = await database.query(
      "SELECT pickup_status FROM orders WHERE id = $1", [orderIdA]
    );
    assert.equal(orderANotRedeemedByOtherStore.rows[0].pickup_status, "ready", "cross-store attempt must not change order state");

    // 5. Merchant lookup + redeem for order A.
    const lookup = await lookupPickupCode({
      actorUserId: fixture.merchantUserId,
      pickupCode: credentialForOrderA.pickupCode,
      pickupCredentialRepository: repository,
    });
    assert.equal(lookup.credential.orderId, orderIdA);
    assert.equal(lookup.credential.status, "active");

    const redeemed = await redeemPickupCode({
      actorUserId: fixture.merchantUserId,
      pickupCode: credentialForOrderA.pickupCode,
      pickupCredentialRepository: repository,
    });
    assert.equal(redeemed.status, "redeemed");
    assert.equal(redeemed.activityCompleted, false, "order B is still not picked up");
    assert.equal(redeemed.credential.orderStatus, "completed");

    const orderAAfterRedeem = await database.query(
      "SELECT status, pickup_status FROM orders WHERE id = $1", [orderIdA]
    );
    assert.deepEqual(orderAAfterRedeem.rows[0], { status: "completed", pickup_status: "picked_up" });

    // 6. Redeeming the same code again is rejected, not silently re-accepted.
    const redeemedAgain = await redeemPickupCode({
      actorUserId: fixture.merchantUserId,
      pickupCode: credentialForOrderA.pickupCode,
      pickupCredentialRepository: repository,
    });
    assert.equal(redeemedAgain.error, "credential_already_redeemed");

    // 7. Redeeming order B's code completes the activity (last captured order picked up).
    const credentialForOrderB = await getPickupCredentialForOrder(orderIdB, {
      pickupCredentialRepository: repository,
    });
    const redeemedB = await redeemPickupCode({
      actorUserId: fixture.merchantUserId,
      pickupCode: credentialForOrderB.pickupCode,
      pickupCredentialRepository: repository,
    });
    assert.equal(redeemedB.status, "redeemed");
    assert.equal(redeemedB.activityCompleted, true, "last captured order picked up should complete the activity");

    const activityAfterRedeemAll = await database.query(
      "SELECT status FROM group_buy_activities WHERE id = $1", [activityId]
    );
    assert.equal(activityAfterRedeemAll.rows[0].status, "completed");

    // 8. Pickup window expiration path, on a separate already-past-window fixture.
    const dueActivities = await repository.listDueActivities({ now: new Date().toISOString(), limit: 20 });
    assert.ok(
      dueActivities.some((activity) => activity.id === expiredActivityId),
      "expired-window fixture activity should show up as due"
    );
    const expireResult = await repository.expireWindow({
      activityId: expiredActivityId,
      actorUserId: fixture.merchantUserId,
      now: new Date().toISOString(),
    });
    assert.equal(expireResult.status, "completed");
    assert.equal(expireResult.expiredOrderCount, 1);

    const expiredOrderAfter = await database.query(
      "SELECT status, pickup_status FROM orders WHERE id = $1", [expiredOrderId]
    );
    assert.deepEqual(expiredOrderAfter.rows[0], { status: "completed", pickup_status: "expired" });
    const expiredActivityAfter = await database.query(
      "SELECT status FROM group_buy_activities WHERE id = $1", [expiredActivityId]
    );
    assert.equal(expiredActivityAfter.rows[0].status, "completed");

    console.log("PostgreSQL pickup credential mark-ready/lookup/redeem/lock/expiration proof passed.");
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
  const otherStoreMerchantResult = await database.query(`
    SELECT user_id FROM merchant_users
    WHERE store_id != 'store-001' AND status = 'active'
    LIMIT 1
  `);
  assert.ok(otherStoreMerchantResult.rows[0], "A merchant user from a different store is required");
  const customersResult = await database.query(`
    SELECT user_account.id
    FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'customer'
      AND user_role.status = 'active'
      AND user_account.status = 'active'
    ORDER BY user_account.id
    LIMIT 2
  `);
  assert.equal(customersResult.rows.length, 2, "Two active PostgreSQL customers are required");
  const merchantUserId = merchantResult.rows[0].user_id;

  const now = new Date();
  const start = new Date(now.getTime() - 40 * 60_000);
  const deadline = new Date(now.getTime() - 30 * 60_000);
  const pickupStart = new Date(now.getTime() - 10 * 60_000);
  const pickupEnd = new Date(now.getTime() + 60 * 60_000);

  const expiredStart = new Date(now.getTime() - 6 * 60 * 60_000);
  const expiredDeadline = new Date(now.getTime() - 5 * 60 * 60_000);
  const expiredPickupStart = new Date(now.getTime() - 4 * 60 * 60_000);
  const expiredPickupEnd = new Date(now.getTime() - 3 * 60 * 60_000 - 30 * 60_000);

  await database.transaction(async (transaction) => {
    await transaction.query(`
      INSERT INTO group_buy_activities (
        id, store_id, created_by_user_id, title, status,
        start_at, deadline_at, pickup_start_at, pickup_end_at,
        maximum_cups, withdrawal_lock_minutes, created_at, updated_at
      ) VALUES ($1, 'store-001', $2, 'PostgreSQL Pickup Proof', 'ordering',
                $3, $4, $5, $6, 2, 30, $4, $4)
    `, [activityId, merchantUserId, start.toISOString(), deadline.toISOString(),
      pickupStart.toISOString(), pickupEnd.toISOString()]);
    for (const [index, orderId] of [orderIdA, orderIdB].entries()) {
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference,
          total_cups, original_amount, final_amount, payment_status,
          authorization_status, merchant_acceptance_status, pickup_status,
          submitted_at, updated_at
        ) VALUES ($1, $2, $3, 'submitted', 'decline_original_price',
                  1, 60, 60, 'captured', 'captured', 'accepted', 'not_ready', $4, $4)
      `, [orderId, activityId, customersResult.rows[index].id, now.toISOString()]);
    }

    await transaction.query(`
      INSERT INTO group_buy_activities (
        id, store_id, created_by_user_id, title, status,
        start_at, deadline_at, pickup_start_at, pickup_end_at,
        maximum_cups, withdrawal_lock_minutes, created_at, updated_at
      ) VALUES ($1, 'store-001', $2, 'PostgreSQL Pickup Expiration Proof', 'ready_for_pickup',
                $3, $4, $5, $6, 1, 30, $4, $4)
    `, [expiredActivityId, merchantUserId, expiredStart.toISOString(), expiredDeadline.toISOString(),
      expiredPickupStart.toISOString(), expiredPickupEnd.toISOString()]);
    await transaction.query(`
      INSERT INTO orders (
        id, activity_id, customer_user_id, status, fallback_purchase_preference,
        total_cups, original_amount, final_amount, payment_status,
        authorization_status, merchant_acceptance_status, pickup_status,
        submitted_at, updated_at
      ) VALUES ($1, $2, $3, 'submitted', 'decline_original_price',
                1, 60, 60, 'captured', 'captured', 'accepted', 'ready', $4, $4)
    `, [expiredOrderId, expiredActivityId, customersResult.rows[0].id, now.toISOString()]);
  });

  return { merchantUserId, otherStoreMerchantUserId: otherStoreMerchantResult.rows[0].user_id };
}

async function cleanup(database) {
  const activityIds = [activityId, expiredActivityId];
  const orderIds = [orderIdA, orderIdB, expiredOrderId];
  await database.transaction(async (transaction) => {
    await transaction.query(
      "DELETE FROM pickup_credentials WHERE order_id = ANY($1::text[])", [orderIds]
    );
    await transaction.query(
      "DELETE FROM status_history WHERE resource_type IN ('activity', 'pickup', 'order') "
      + "AND resource_id = ANY($1::text[])",
      [[...activityIds, ...orderIds]]
    );
    await transaction.query(
      "DELETE FROM audit_logs WHERE resource_type IN ('activity', 'order') AND resource_id = ANY($1::text[])",
      [[...activityIds, ...orderIds]]
    );
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query(
      "DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]
    );
    await transaction.query(
      "DELETE FROM operation_locks WHERE lock_key LIKE '%' || $1 || '%'", [proofId]
    );
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($1::text[])) AS activity_count,
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($2::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM pickup_credentials WHERE order_id = ANY($2::text[])) AS credential_count,
      (SELECT COUNT(*)::integer FROM operation_locks WHERE lock_key LIKE '%' || $3 || '%') AS lock_count
  `, [activityIds, orderIds, proofId]);
  assert.deepEqual(residue.rows[0], {
    activity_count: 0,
    order_count: 0,
    credential_count: 0,
    lock_count: 0,
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
