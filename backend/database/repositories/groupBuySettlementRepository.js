"use strict";

const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("..");
const { calculatePercentageDiscount, resolveAppliedDiscountTier } = require("../../pricing/groupBuyDiscount");

function resolveGroupBuySettlementRuntime(input = {}) {
  const env = input.env || process.env;
  const runtime = String(input.runtime || env.GROUP_BUY_SETTLEMENT_RUNTIME || "sqlite")
    .trim()
    .toLowerCase();
  if (runtime === "sqlite") return "sqlite";
  if (runtime === "postgres" || runtime === "postgresql") return "postgres";
  throw new Error(`Unsupported GROUP_BUY_SETTLEMENT_RUNTIME: ${runtime}`);
}

function createGroupBuySettlementRepository(input = {}) {
  const runtime = resolveGroupBuySettlementRuntime(input);
  if (runtime === "sqlite") return createSqliteRepository(input.sqliteGateway || {});

  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    withOperationLock: (value, operation) => withPostgresSettlementLock(database, value, operation),
    createPlan: (value) => createPostgresSettlementPlan(database, value),
    getCaptureRetryState: (value) => getPostgresCaptureRetryState(database, value),
    completeSettlement: (value) => completePostgresSettlement(database, value),
    listSettlementOutcomeOrders: (value) => listPostgresSettlementOutcomeOrders(database, value),
    listDueActivities: (value) => listPostgresDueActivities(database, value),
    enqueueJob: (value) => enqueuePostgresSettlementJob(database, value),
    claimJobs: (value) => claimPostgresSettlementJobs(database, value),
    completeJob: (value) => completePostgresSettlementJob(database, value),
    rescheduleJob: (value) => reschedulePostgresSettlementJob(database, value),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

function createSqliteRepository(gateway) {
  const required = [
    "createPlan", "getCaptureRetryState", "completeSettlement", "listDueActivities",
    "enqueueJob", "claimJobs", "completeJob", "rescheduleJob",
  ];
  for (const name of required) {
    if (typeof gateway[name] !== "function") {
      throw new Error(`${name} is required when GROUP_BUY_SETTLEMENT_RUNTIME=sqlite`);
    }
  }
  return {
    kind: "sqlite",
    createPlan: async (value) => gateway.createPlan(value),
    getCaptureRetryState: async (value) => gateway.getCaptureRetryState(value),
    completeSettlement: async (value) => gateway.completeSettlement(value),
    listDueActivities: async (value) => gateway.listDueActivities(value),
    enqueueJob: async (value) => gateway.enqueueJob(value),
    claimJobs: async (value) => gateway.claimJobs(value),
    completeJob: async (value) => gateway.completeJob(value),
    rescheduleJob: async (value) => gateway.rescheduleJob(value),
    close: async () => {},
  };
}

async function withPostgresSettlementLock(database, input = {}, operation) {
  const lockKey = `settlement:activity:${input.activityId}`;
  const ownerId = input.lockOwnerId || `settlement-${process.pid}-${randomUUID()}`;
  const now = input.now || new Date().toISOString();
  const leaseMs = normalizePositiveInteger(input.leaseMs, 300_000);
  const lockedUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  const acquired = await database.query(`
    INSERT INTO operation_locks (lock_key, owner_id, locked_until, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $4)
    ON CONFLICT (lock_key) DO UPDATE
    SET owner_id = EXCLUDED.owner_id,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at
    WHERE operation_locks.locked_until <= $4
    RETURNING lock_key, owner_id, locked_until
  `, [lockKey, ownerId, lockedUntil, now]);
  if (!acquired.rows[0]) {
    const current = await database.query(
      "SELECT owner_id, locked_until FROM operation_locks WHERE lock_key = $1",
      [lockKey]
    );
    return {
      error: "settlement_locked",
      activityId: input.activityId,
      lockedUntil: toIsoString(current.rows[0]?.locked_until),
    };
  }
  try {
    return await operation();
  } finally {
    await database.query(
      "DELETE FROM operation_locks WHERE lock_key = $1 AND owner_id = $2",
      [lockKey, ownerId]
    );
  }
}

async function createPostgresSettlementPlan(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const actorUserId = input.actorUserId || null;
  const force = Boolean(input.force);
  return database.transaction(async (transaction) => {
    const activityResult = await transaction.query(
      "SELECT * FROM group_buy_activities WHERE id = $1 FOR UPDATE",
      [input.activityId]
    );
    const activity = activityResult.rows[0];
    if (!activity) return null;

    const settlementResult = await transaction.query(
      "SELECT * FROM activity_settlements WHERE activity_id = $1",
      [input.activityId]
    );
    if (settlementResult.rows[0]) {
      return {
        error: "activity_already_settled",
        settlement: mapSettlement(settlementResult.rows[0]),
      };
    }
    if (activity.status === "cancelled") return { error: "activity_cancelled", status: activity.status };
    if (["failed", "completed", "ready_for_pickup"].includes(activity.status)) {
      return { error: "activity_not_settleable", status: activity.status };
    }
    if (!force && Date.parse(activity.deadline_at) > Date.parse(now)) {
      return { error: "settlement_not_due", deadlineAt: toIsoString(activity.deadline_at), now };
    }

    const tiersResult = await transaction.query(`
      SELECT id, target_cups, discount_percent, sort_order
      FROM promotion_tiers
      WHERE activity_id = $1
      ORDER BY target_cups ASC, sort_order ASC
    `, [input.activityId]);
    const ordersResult = await transaction.query(`
      SELECT order_record.*,
             selected_auth.id AS payment_authorization_id,
             selected_auth.provider AS payment_provider,
             selected_auth.provider_authorization_id,
             selected_auth.authorized_amount,
             selected_auth.status AS payment_authorization_status
      FROM orders order_record
      LEFT JOIN LATERAL (
        SELECT payment_auth.*
        FROM payment_authorizations payment_auth
        WHERE payment_auth.order_id = order_record.id
          AND payment_auth.provider IN ('line_pay', 'mock_line_pay')
          AND payment_auth.status IN ('authorized', 'captured')
        ORDER BY payment_auth.authorized_at DESC NULLS LAST, payment_auth.created_at DESC
        LIMIT 1
      ) selected_auth ON TRUE
      WHERE order_record.activity_id = $1
        AND order_record.payment_status IN ('authorized', 'captured')
        AND order_record.status != 'cancelled'
      ORDER BY order_record.submitted_at ASC
      FOR UPDATE OF order_record
    `, [input.activityId]);

    const tiers = tiersResult.rows;
    const orderRows = ordersResult.rows;
    const authorizedCups = orderRows.reduce((sum, order) => sum + Number(order.total_cups), 0);
    const discountSummary = resolveAppliedDiscountTier(tiers, authorizedCups);
    const appliedTier = tiers.find((tier) => tier.id === discountSummary.currentTierId) || null;
    const outcome = appliedTier ? "qualified" : "failed";
    const discountPercent = discountSummary.currentTierDiscountPercent;
    // Each order's discount is computed against ITS OWN original_amount -- a percentage
    // discount can't be pre-allocated per cup the way a flat-amount tier could, since two
    // orders at the same tier can owe different discounts if their items are priced differently.
    const orders = orderRows.map((order) => mapSettlementOrder(order, {
      outcome,
      appliedTier,
      discountPercent,
    }));
    const totalDiscountAmount = orders.reduce((sum, order) => sum + order.discountAmount, 0);

    if (activity.status !== "ordering") {
      await transaction.query(
        "UPDATE group_buy_activities SET status = 'ordering', updated_at = $1 WHERE id = $2",
        [now, input.activityId]
      );
      await transaction.query(`
        INSERT INTO status_history (
          id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
        ) VALUES ($1, 'activity', $2, $3, 'ordering', 'deadline_settlement_started', $4, $5)
      `, [`status-history-${randomUUID()}`, input.activityId, activity.status, actorUserId, now]);
    }
    await transaction.query(`
      UPDATE orders
      SET status = 'locked', updated_at = $1
      WHERE activity_id = $2 AND status = 'submitted' AND payment_status = 'authorized'
    `, [now, input.activityId]);
    // Orders whose customer never even attempted LINE Pay (payment_status stays 'pending'
    // forever) are otherwise invisible to settlement -- they'd sit as "active" indefinitely
    // since getOrderLifecycleBucket has no pending-forever branch. Resolve them to cancelled
    // now that the deadline has passed, using the same field set the merchant/customer cancel
    // repositories use, so they correctly reclassify into order history.
    const neverPaidResult = await transaction.query(`
      UPDATE orders
      SET status = 'cancelled', pickup_status = 'cancelled', merchant_acceptance_status = 'cancelled', updated_at = $1
      WHERE activity_id = $2 AND status = 'submitted' AND payment_status = 'pending'
      RETURNING id
    `, [now, input.activityId]);
    const neverPaidOrderCount = neverPaidResult.rows.length;
    await insertAudit(transaction, actorUserId, "start_group_buy_settlement", input.activityId, {
      force,
      authorizedCups,
      outcome,
      appliedTierId: appliedTier?.id || null,
      discountPercent,
      totalDiscountAmount,
      discountFunder: "merchant",
      neverPaidOrderCount,
    }, now);

    return {
      activity: mapActivity(activity),
      outcome,
      authorizedCups,
      appliedTier: appliedTier ? mapTier(appliedTier) : null,
      discountPercent,
      totalDiscountAmount,
      discountFunder: "merchant",
      capturedOrderCount: orders.filter((order) => order.action === "already_captured").length,
      neverPaidOrderCount,
      orders,
    };
  });
}

async function getPostgresCaptureRetryState(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const maxAttempts = normalizePositiveInteger(input.maxAttempts, 3);
  const authorizationResult = await database.query(`
    SELECT payment_auth.*
    FROM payment_authorizations payment_auth
    WHERE payment_auth.provider = $1
      AND ($2::text IS NULL OR payment_auth.provider_authorization_id = $2)
      AND ($3::text IS NULL OR payment_auth.order_id = $3)
    ORDER BY payment_auth.created_at DESC, payment_auth.id DESC
    LIMIT 1
  `, [input.provider || "line_pay", input.providerTransactionId || null, input.orderId || null]);
  const authorization = authorizationResult.rows[0];
  if (!authorization) return null;
  const attemptsResult = await database.query(`
    SELECT * FROM payment_captures
    WHERE payment_authorization_id = $1 AND status = 'failed'
    ORDER BY created_at DESC, id DESC
  `, [authorization.id]);
  const attempts = attemptsResult.rows;
  const latestAttempt = attempts[0] || null;
  const attemptCount = attempts.length;
  const retryable = Boolean(latestAttempt?.retryable);
  const nextRetryAt = toIsoString(latestAttempt?.next_retry_at);
  const nextRetryTime = nextRetryAt ? Date.parse(nextRetryAt) : null;
  const exhausted = attemptCount >= maxAttempts || (attemptCount > 0 && !retryable);
  return {
    authorization: mapAuthorization(authorization),
    attemptCount,
    maxAttempts,
    retryable,
    exhausted,
    retryDue: attemptCount === 0 || (!exhausted && (nextRetryTime == null || nextRetryTime <= Date.parse(now))),
    nextRetryAt,
    latestAttempt: latestAttempt ? mapCapture(latestAttempt) : null,
  };
}

async function completePostgresSettlement(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const capturedOrderCount = Number(input.capturedOrderCount || 0);
  const outcome = input.outcome || "failed";
  const finalStatus = outcome === "qualified" || capturedOrderCount > 0 ? "ordering" : "failed";
  const authorizedCups = Number(input.authorizedCups || 0);
  const totalDiscountAmount = Number(input.totalDiscountAmount || 0);
  // Upstream (resolveAppliedDiscountTier via the settlement plan) reports 0, not null, when no
  // tier is applied -- normalize to the DB's actual "no discount" representation (NULL, matching
  // the discount_percent CHECK constraint's IS NULL OR BETWEEN 1 AND 99) based on outcome, rather
  // than trusting the caller to already distinguish "no tier" from "not yet computed".
  const discountPercent = outcome === "qualified"
    ? (input.discountPercent == null ? null : Number(input.discountPercent))
    : null;
  const discountPercentValid = Number.isInteger(discountPercent)
    && discountPercent >= 1 && discountPercent <= 99;
  if (outcome === "qualified" && !discountPercentValid) {
    return { error: "settlement_discount_snapshot_inconsistent" };
  }
  if (outcome !== "qualified" && totalDiscountAmount !== 0) {
    return { error: "settlement_discount_snapshot_inconsistent" };
  }

  return database.transaction(async (transaction) => {
    const activityResult = await transaction.query(
      "SELECT * FROM group_buy_activities WHERE id = $1 FOR UPDATE",
      [input.activityId]
    );
    const activity = activityResult.rows[0];
    if (!activity) return null;
    const existing = await transaction.query(
      "SELECT * FROM activity_settlements WHERE activity_id = $1",
      [input.activityId]
    );
    if (existing.rows[0]) {
      return { settlement: mapSettlement(existing.rows[0]), alreadyCompleted: true };
    }
    const settlementId = `activity-settlement-${randomUUID()}`;
    const inserted = await transaction.query(`
      INSERT INTO activity_settlements (
        id, activity_id, outcome, authorized_cups, applied_tier_id, total_discount_amount,
        discount_percent, discount_funder, calculation_version, settled_at, reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'percentage_v1', $9, $10)
      RETURNING *
    `, [
      settlementId, input.activityId, outcome, authorizedCups, input.appliedTierId || null,
      totalDiscountAmount, discountPercent,
      input.discountFunder || "merchant", now, input.reason || "deadline_settlement_completed",
    ]);
    await transaction.query(
      "UPDATE group_buy_activities SET status = $1, updated_at = $2 WHERE id = $3",
      [finalStatus, now, input.activityId]
    );
    if (activity.status !== finalStatus) {
      await transaction.query(`
        INSERT INTO status_history (
          id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
        ) VALUES ($1, 'activity', $2, $3, $4, 'deadline_settlement_completed', $5, $6)
      `, [`status-history-${randomUUID()}`, input.activityId, activity.status, finalStatus,
        input.actorUserId || null, now]);
    }
    await insertAudit(transaction, input.actorUserId || null, "complete_group_buy_settlement", input.activityId, {
      outcome,
      finalStatus,
      capturedOrderCount,
      voidedOrderCount: Number(input.voidedOrderCount || 0),
      failedOrderCount: Number(input.failedOrderCount || 0),
      appliedTierId: input.appliedTierId || null,
      totalDiscountAmount,
      discountPercent,
      discountFunder: input.discountFunder || "merchant",
      calculationVersion: "percentage_v1",
    }, now);
    return {
      settlement: mapSettlement(inserted.rows[0]),
      activity: { ...mapActivity(activity), status: finalStatus },
    };
  });
}

// Final per-order money outcome of a settled, NOT-qualified activity, read from the orders
// themselves rather than from one settlement run's in-memory results. A settlement that needed a
// retry spreads its work over several runs, and a later run's plan only contains orders that are
// still 'authorized' or 'captured', so orders an earlier run already voided (or captured) are not in
// its results -- the notification audience has to come from here to include them. A customer who
// withdrew has status 'cancelled' and is excluded; settlement's own void leaves status unchanged.
async function listPostgresSettlementOutcomeOrders(database, input = {}) {
  const result = await database.query(`
    SELECT id, customer_user_id, payment_status, fallback_purchase_preference
    FROM orders
    WHERE activity_id = $1
      AND status != 'cancelled'
      AND payment_status IN ('authorization_voided', 'captured')
  `, [input.activityId]);
  return result.rows.map((row) => ({
    id: row.id,
    customerUserId: row.customer_user_id,
    paymentStatus: row.payment_status,
    fallbackPurchasePreference: row.fallback_purchase_preference,
  }));
}

async function listPostgresDueActivities(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const limit = Math.min(normalizePositiveInteger(input.limit, 20), 100);
  const result = await database.query(`
    SELECT activity.id, activity.status, activity.deadline_at
    FROM group_buy_activities activity
    LEFT JOIN activity_settlements settlement ON settlement.activity_id = activity.id
    WHERE settlement.id IS NULL
      AND activity.status IN ('recruiting', 'confirmed', 'ordering')
      AND activity.deadline_at <= $1
    ORDER BY activity.deadline_at ASC
    LIMIT $2
  `, [now, limit]);
  return result.rows.map((row) => ({
    id: row.id,
    status: row.status,
    deadlineAt: toIsoString(row.deadline_at),
  }));
}

async function enqueuePostgresSettlementJob(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const runAfter = input.runAfter || now;
  const maxAttempts = normalizePositiveInteger(input.maxAttempts, 20);
  return database.transaction(async (transaction) => {
    const id = input.id || `payment-job-${randomUUID()}`;
    const inserted = await transaction.query(`
      INSERT INTO payment_reliability_jobs (
        id, job_type, resource_type, resource_id, status, payload_json,
        attempt_count, max_attempts, run_after, alert_required, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, 0, $6, $7, false, $8, $8)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [id, input.jobType, input.resourceType, input.resourceId,
      JSON.stringify(input.payload || {}), maxAttempts, runAfter, now]);
    if (inserted.rows[0]) return mapJob(inserted.rows[0]);
    const existing = await transaction.query(`
      UPDATE payment_reliability_jobs
      SET payload_json = $1::jsonb,
          max_attempts = GREATEST(max_attempts, $2),
          updated_at = $3
      WHERE job_type = $4 AND resource_type = $5 AND resource_id = $6
        AND status IN ('queued', 'running', 'retry_wait')
      RETURNING *
    `, [JSON.stringify(input.payload || {}), maxAttempts, now,
      input.jobType, input.resourceType, input.resourceId]);
    return mapJob(existing.rows[0]);
  });
}

async function claimPostgresSettlementJobs(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const limit = Math.min(normalizePositiveInteger(input.limit, 10), 100);
  const leaseMs = Math.max(normalizePositiveInteger(input.leaseMs, 120_000), 1_000);
  const lockedUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  return database.transaction(async (transaction) => {
    await transaction.query(`
      UPDATE payment_reliability_jobs
      SET status = 'failed', locked_by = NULL, locked_until = NULL,
          alert_required = true,
          last_error_json = '{"reason":"worker_lease_expired_after_final_attempt"}'::jsonb,
          completed_at = $1, updated_at = $1
      WHERE status = 'running' AND locked_until <= $1 AND attempt_count >= max_attempts
    `, [now]);
    const result = await transaction.query(`
      WITH claimable AS (
        SELECT id
        FROM payment_reliability_jobs
        WHERE job_type = $1 AND attempt_count < max_attempts
          AND ((status IN ('queued', 'retry_wait') AND run_after <= $2)
            OR (status = 'running' AND locked_until <= $2))
        ORDER BY run_after ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $3
      )
      UPDATE payment_reliability_jobs job
      SET status = 'running', attempt_count = job.attempt_count + 1,
          locked_by = $4, locked_until = $5, updated_at = $2
      FROM claimable
      WHERE job.id = claimable.id
      RETURNING job.*
    `, [input.jobType, now, limit, input.workerId, lockedUntil]);
    return result.rows.map(mapJob);
  });
}

async function completePostgresSettlementJob(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const result = await database.query(`
    UPDATE payment_reliability_jobs
    SET status = 'succeeded', locked_by = NULL, locked_until = NULL,
        last_error_json = NULL, alert_required = false, completed_at = $1, updated_at = $1
    WHERE id = $2 AND status = 'running' AND locked_by = $3
    RETURNING *
  `, [now, input.jobId, input.workerId]);
  return mapJob(result.rows[0]);
}

async function reschedulePostgresSettlementJob(database, input = {}) {
  const now = input.now || new Date().toISOString();
  return database.transaction(async (transaction) => {
    const current = await transaction.query(`
      SELECT * FROM payment_reliability_jobs
      WHERE id = $1 AND status = 'running' AND locked_by = $2
      FOR UPDATE
    `, [input.jobId, input.workerId]);
    const row = current.rows[0];
    if (!row) return null;
    const terminal = Boolean(input.terminal) || Number(row.attempt_count) >= Number(row.max_attempts);
    const result = await transaction.query(`
      UPDATE payment_reliability_jobs
      SET status = $1, run_after = $2, locked_by = NULL, locked_until = NULL,
          last_error_json = $3::jsonb, alert_required = $4,
          completed_at = $5, updated_at = $6
      WHERE id = $7 AND locked_by = $8
      RETURNING *
    `, [terminal ? "failed" : "retry_wait", input.runAfter || now,
      JSON.stringify(input.error || {}), terminal, terminal ? now : null, now,
      input.jobId, input.workerId]);
    return mapJob(result.rows[0]);
  });
}

async function insertAudit(database, actorUserId, actionType, resourceId, metadata, now) {
  await database.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
    ) VALUES ($1, $2, $3, 'activity', $4, $5::jsonb, $6)
  `, [`audit-log-${randomUUID()}`, actorUserId, actionType, resourceId,
    JSON.stringify(metadata), now]);
}

function mapSettlementOrder(row, context) {
  const originalAmount = Number(row.original_amount);
  const alreadyCaptured = row.payment_status === "captured";
  const { finalAmount, discountAmount } = context.appliedTier
    ? calculatePercentageDiscount(originalAmount, context.discountPercent)
    : { finalAmount: originalAmount, discountAmount: 0 };
  let action = "void";
  let actionReason = "discount_not_qualified";
  if (alreadyCaptured) {
    action = "already_captured";
    actionReason = "already_captured";
  } else if (!row.payment_authorization_id) {
    action = "error_missing_authorization";
    actionReason = "authorized_order_missing_authorization";
  } else if (context.outcome === "qualified") {
    action = "capture";
    actionReason = "discount_qualified";
  } else if (row.fallback_purchase_preference === "accept_original_price") {
    action = "capture";
    actionReason = "fallback_original_price_accepted";
  }
  return {
    id: row.id,
    activityId: row.activity_id,
    customerUserId: row.customer_user_id,
    paymentAuthorizationId: row.payment_authorization_id,
    paymentProvider: row.payment_provider,
    providerTransactionId: row.provider_authorization_id,
    paymentStatus: row.payment_status,
    orderStatus: row.status,
    fallbackPurchasePreference: row.fallback_purchase_preference,
    totalCups: Number(row.total_cups),
    originalAmount,
    discountAmount,
    authorizedAmount: Number(row.authorized_amount),
    finalAmount,
    captureAmount: finalAmount,
    action,
    actionReason,
  };
}

function mapSettlement(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    outcome: row.outcome,
    authorizedCups: Number(row.authorized_cups),
    appliedTierId: row.applied_tier_id,
    totalDiscountAmount: Number(row.total_discount_amount),
    discountPercent: row.discount_percent == null ? null : Number(row.discount_percent),
    discountFunder: row.discount_funder,
    calculationVersion: row.calculation_version,
    settledAt: toIsoString(row.settled_at),
    reason: row.reason,
  };
}

function mapActivity(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    deadlineAt: toIsoString(row.deadline_at),
    maximumCups: Number(row.maximum_cups),
  };
}

function mapTier(row) {
  return {
    id: row.id,
    targetCups: Number(row.target_cups),
    discountPercent: Number(row.discount_percent),
    sortOrder: Number(row.sort_order),
  };
}

function mapAuthorization(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    provider: row.provider,
    status: row.status,
    originalAmount: Number(row.original_amount),
    authorizedAmount: Number(row.authorized_amount),
    providerAuthorizationId: row.provider_authorization_id,
  };
}

function mapCapture(row) {
  return {
    id: row.id,
    paymentAuthorizationId: row.payment_authorization_id,
    orderId: row.order_id,
    status: row.status,
    finalAmount: Number(row.final_amount),
    captureAmount: Number(row.capture_amount),
    failureReason: row.failure_reason,
    attemptNumber: Number(row.attempt_number),
    retryable: Boolean(row.retryable),
    nextRetryAt: toIsoString(row.next_retry_at),
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    status: row.status,
    payload: parseJson(row.payload_json) || {},
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    runAfter: toIsoString(row.run_after),
    lockedBy: row.locked_by,
    lockedUntil: toIsoString(row.locked_until),
    lastError: parseJson(row.last_error_json),
    alertRequired: Boolean(row.alert_required),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: toIsoString(row.completed_at),
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return { raw: value }; }
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value || null;
}

module.exports = {
  claimPostgresSettlementJobs,
  completePostgresSettlement,
  completePostgresSettlementJob,
  createGroupBuySettlementRepository,
  createPostgresSettlementPlan,
  enqueuePostgresSettlementJob,
  getPostgresCaptureRetryState,
  listPostgresDueActivities,
  mapJob,
  resolveGroupBuySettlementRuntime,
  reschedulePostgresSettlementJob,
  withPostgresSettlementLock,
};
