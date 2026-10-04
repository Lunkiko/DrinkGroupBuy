"use strict";

const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("..");
const { withOperationLease } = require("../../reliability/operationLease");
const { withPostgresPaymentOperationLock } = require("./paymentAuthorizationCancelRepository");

function resolveMerchantActivityCancelRuntime(input = {}) {
  const env = input.env || process.env;
  const runtime = String(
    input.runtime || env.MERCHANT_ACTIVITY_CANCEL_RUNTIME || "sqlite"
  ).trim().toLowerCase();
  if (runtime === "sqlite") return "sqlite";
  if (runtime === "postgres" || runtime === "postgresql") return "postgres";
  throw new Error(`Unsupported MERCHANT_ACTIVITY_CANCEL_RUNTIME: ${runtime}`);
}

function createMerchantGroupBuyActivityCancelRepository(input = {}) {
  const runtime = resolveMerchantActivityCancelRuntime(input);
  if (runtime === "sqlite") {
    const gateway = input.sqliteGateway || {};
    for (const name of ["getActivityForCancellation", "listEligibleOrders", "cancelOrder"]) {
      if (typeof gateway[name] !== "function") {
        throw new Error(`${name} is required when MERCHANT_ACTIVITY_CANCEL_RUNTIME=sqlite`);
      }
    }
    if (typeof gateway.cancelActivityStatus !== "function") {
      throw new Error("cancelActivityStatus is required when MERCHANT_ACTIVITY_CANCEL_RUNTIME=sqlite");
    }
    return {
      kind: "sqlite",
      getActivityForCancellation: async (value) => gateway.getActivityForCancellation(value.activityId),
      listEligibleOrders: async (value) => gateway.listEligibleOrders(value.activityId),
      cancelOrder: async (value) => gateway.cancelOrder(value),
      cancelActivityStatus: async (value) => gateway.cancelActivityStatus(value.activityId, value),
      withOperationLock: (value, operation) => withOperationLease(
        { lockKey: `order:${value.orderId}:payment-lifecycle`, leaseMs: value.leaseMs, now: value.now },
        operation
      ),
      close: async () => {},
    };
  }

  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    getActivityForCancellation: (value) => getPostgresActivityForCancellation(database, value),
    listEligibleOrders: (value) => listPostgresEligibleOrders(database, value),
    cancelOrder: (value) => cancelPostgresMerchantOrder(database, value),
    cancelActivityStatus: (value) => cancelPostgresActivityStatus(database, value),
    withOperationLock: (value, operation) => withPostgresPaymentOperationLock(database, value, operation),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

async function getPostgresActivityForCancellation(database, input = {}) {
  const result = await database.query(`
    SELECT id, store_id, title, status, deadline_at, withdrawal_lock_minutes, cancellation_reason
    FROM group_buy_activities
    WHERE id = $1
  `, [input.activityId]);
  return result.rows[0] || null;
}

async function listPostgresEligibleOrders(database, input = {}) {
  const result = await database.query(`
    SELECT
      orders.id,
      orders.customer_user_id,
      orders.payment_status,
      payment_auth.provider AS payment_provider
    FROM orders
    -- "authorization" is a reserved word in PostgreSQL and cannot be used as a bare table
    -- alias (confirmed against a real PostgreSQL 16 server).
    LEFT JOIN payment_authorizations payment_auth
      ON payment_auth.id = (
        SELECT id
        FROM payment_authorizations
        WHERE order_id = orders.id
          AND status IN ('authorized', 'captured')
        ORDER BY authorized_at DESC, created_at DESC
        LIMIT 1
      )
    WHERE orders.activity_id = $1
      AND orders.status != 'cancelled'
      AND orders.payment_status NOT IN ('captured', 'refunded')
  `, [input.activityId]);
  return result.rows;
}

async function cancelPostgresMerchantOrder(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const initial = await database.query(`
    SELECT activity_id FROM orders WHERE id = $1
  `, [input.orderId]);
  if (!initial.rows[0]) return { error: "order_not_found" };
  if (initial.rows[0].activity_id !== input.activityId) return { error: "order_access_denied" };

  return database.transaction(async (transaction) => {
    if (input.idempotencyKey) {
      const actionResult = await transaction.query(`
        SELECT order_id, actor_user_id, action_type, result_json
        FROM order_action_idempotency
        WHERE idempotency_key = $1
      `, [input.idempotencyKey]);
      const action = actionResult.rows[0];
      if (action) {
        if (action.order_id !== input.orderId
          || action.actor_user_id !== input.actorUserId
          || action.action_type !== "merchant_cancel_order") {
          return { error: "idempotency_key_conflict" };
        }
        return { ...action.result_json, idempotent: true };
      }
    }

    const orderResult = await transaction.query(`
      SELECT * FROM orders WHERE id = $1 FOR UPDATE
    `, [input.orderId]);
    const order = orderResult.rows[0];
    if (!order) return { error: "order_not_found" };
    if (order.status === "cancelled") {
      return { orderId: order.id, status: "cancelled", idempotent: true };
    }
    if (["captured", "refunded"].includes(order.payment_status)) {
      return { error: "captured_order_cannot_be_cancelled" };
    }
    if (order.payment_status === "authorized") {
      return { error: "authorization_void_required", paymentStatus: order.payment_status };
    }
    // Defensive: payment_status is CHECK-constrained to {pending, authorized, captured,
    // authorization_voided, failed, refunded}, so this currently can't trigger against real data —
    // kept as a safety net against future schema changes rather than trusting the guards above alone.
    if (!["pending", "authorization_voided", "failed"].includes(order.payment_status)) {
      return { error: "order_not_cancellable", paymentStatus: order.payment_status };
    }

    const pendingAuthorizations = await transaction.query(`
      SELECT id, status
      FROM payment_authorizations
      WHERE order_id = $1 AND status = 'pending'
      FOR UPDATE
    `, [order.id]);
    const updateResult = await transaction.query(`
      UPDATE orders
      SET status = 'cancelled', pickup_status = 'cancelled',
          merchant_acceptance_status = 'cancelled', updated_at = $1
      WHERE id = $2
        AND status != 'cancelled'
        AND payment_status NOT IN ('captured', 'refunded')
      RETURNING id
    `, [now, order.id]);
    if (!updateResult.rows[0]) return { error: "order_state_changed" };

    await transaction.query(`
      UPDATE payment_authorizations
      SET status = 'failed', failure_reason = 'merchant_cancelled_group_buy_activity', updated_at = $1
      WHERE order_id = $2 AND status = 'pending'
    `, [now, order.id]);
    await transaction.query(`
      UPDATE order_revisions
      SET status = 'cancelled', failure_reason = 'merchant_cancelled_group_buy_activity',
          cancelled_at = $1, updated_at = $1
      WHERE order_id = $2 AND status = 'pending_authorization'
    `, [now, order.id]);
    for (const authorization of pendingAuthorizations.rows) {
      await transaction.query(`
        INSERT INTO status_history (
          id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
        ) VALUES ($1, 'payment_authorization', $2, $3, 'failed',
                  'merchant_cancelled_group_buy_activity', $4, $5)
      `, [`status-history-${randomUUID()}`, authorization.id, authorization.status,
        input.actorUserId, now]);
      await transaction.query(`
        UPDATE payment_reliability_jobs
        SET status = 'cancelled', locked_by = NULL, locked_until = NULL,
            updated_at = $1, completed_at = $1
        WHERE job_type = 'reconcile_line_pay_request'
          AND resource_type = 'payment_authorization'
          AND resource_id = $2
          AND status IN ('queued', 'running', 'retry_wait')
      `, [now, authorization.id]);
    }
    await transaction.query(`
      INSERT INTO status_history (
        id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
      ) VALUES ($1, 'order', $2, $3, 'cancelled', $4, $5, $6)
    `, [`status-history-${randomUUID()}`, order.id, order.status,
      input.reason, input.actorUserId, now]);
    await transaction.query(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES ($1, $2, 'merchant_cancel_order', 'order', $3, $4::jsonb, $5)
    `, [`audit-log-${randomUUID()}`, input.actorUserId, order.id,
      JSON.stringify({ reason: input.reason, activityId: input.activityId }), now]);

    const result = { orderId: order.id, status: "cancelled", idempotent: false };
    if (input.idempotencyKey) {
      await transaction.query(`
        INSERT INTO order_action_idempotency (
          idempotency_key, order_id, action_type, actor_user_id, result_json, created_at
        ) VALUES ($1, $2, 'merchant_cancel_order', $3, $4::jsonb, $5)
      `, [input.idempotencyKey, order.id, input.actorUserId, JSON.stringify(result), now]);
    }
    return result;
  });
}

async function cancelPostgresActivityStatus(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const reason = input.reason || "Cancelled by merchant.";
  const actionType = input.actionType || "merchant_cancel_group_buy_activity";

  return database.transaction(async (transaction) => {
    const activityResult = await transaction.query(`
      SELECT id, status FROM group_buy_activities WHERE id = $1 FOR UPDATE
    `, [input.activityId]);
    const activity = activityResult.rows[0];
    if (!activity) return null;
    if (activity.status === "cancelled") {
      return { id: activity.id, status: "cancelled", cancellationReason: null, idempotent: true };
    }

    await transaction.query(`
      UPDATE group_buy_activities
      SET status = 'cancelled', cancellation_reason = $1, updated_at = $2
      WHERE id = $3
    `, [reason, now, input.activityId]);

    await transaction.query(`
      INSERT INTO status_history (
        id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
      ) VALUES ($1, 'activity', $2, $3, 'cancelled', $4, $5, $6)
    `, [`status-history-${randomUUID()}`, input.activityId, activity.status,
      reason, input.actorUserId || null, now]);

    await transaction.query(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES ($1, $2, $3, 'activity', $4, $5::jsonb, $6)
    `, [`audit-log-${randomUUID()}`, input.actorUserId || null, actionType,
      input.activityId, JSON.stringify({ reason }), now]);

    return { id: input.activityId, status: "cancelled", cancellationReason: reason, idempotent: false };
  });
}

module.exports = {
  cancelPostgresActivityStatus,
  cancelPostgresMerchantOrder,
  createMerchantGroupBuyActivityCancelRepository,
  getPostgresActivityForCancellation,
  listPostgresEligibleOrders,
  resolveMerchantActivityCancelRuntime,
};
