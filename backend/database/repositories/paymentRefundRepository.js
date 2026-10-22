"use strict";

const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("..");
const { withPostgresPaymentOperationLock } = require("./paymentAuthorizationCancelRepository");

function resolvePaymentRefundRuntime(input = {}) {
  const env = input.env || process.env;
  const runtime = String(input.runtime || env.PAYMENT_REFUND_RUNTIME || "sqlite")
    .trim()
    .toLowerCase();
  if (runtime === "sqlite") return "sqlite";
  if (runtime === "postgres" || runtime === "postgresql") return "postgres";
  throw new Error(`Unsupported PAYMENT_REFUND_RUNTIME: ${runtime}`);
}

const GATEWAY_METHODS = [
  "createPendingRefund", "completeRefund", "failRefund",
  "createRefundRequest", "approveRefundRequest", "rejectRefundRequest",
  "getRefundRequestById", "listRefundRequestsForStore", "listRefundRequestsForAdmin",
  "getOrderStoreId", "getLatestAuthorizationForOrder", "getLatestProviderEventPayload",
];

function createPaymentRefundRepository(input = {}) {
  const runtime = resolvePaymentRefundRuntime(input);
  if (runtime === "sqlite") {
    const gateway = input.sqliteGateway || {};
    for (const name of GATEWAY_METHODS) {
      if (typeof gateway[name] !== "function") {
        throw new Error(`${name} is required when PAYMENT_REFUND_RUNTIME=sqlite`);
      }
    }
    const wrapped = { kind: "sqlite", close: async () => {} };
    for (const name of GATEWAY_METHODS) {
      wrapped[name] = async (value) => gateway[name](value);
    }
    return wrapped;
  }

  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    createPendingRefund: (value) => createPendingRefundPostgres(database, value),
    completeRefund: (value) => completeRefundPostgres(database, value),
    failRefund: (value) => failRefundPostgres(database, value),
    createRefundRequest: (value) => createRefundRequestPostgres(database, value),
    approveRefundRequest: (value) => approveRefundRequestPostgres(database, value),
    rejectRefundRequest: (value) => rejectRefundRequestPostgres(database, value),
    getRefundRequestById: (value) => getRefundRequestByIdPostgres(database, value),
    listRefundRequestsForStore: (value) => listRefundRequestsForStorePostgres(database, value),
    listRefundRequestsForAdmin: (value) => listRefundRequestsForAdminPostgres(database, value),
    getOrderStoreId: (value) => getOrderStoreIdPostgres(database, value),
    getLatestAuthorizationForOrder: (value) => getLatestAuthorizationForOrderPostgres(database, value),
    getLatestProviderEventPayload: (value) => getLatestProviderEventPayloadPostgres(database, value),
    withOperationLock: (value, operation) => withPostgresPaymentOperationLock(database, value, operation),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Provider refund execution.
// ---------------------------------------------------------------------------

async function createPendingRefundPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const provider = input.provider || "line_pay";
  const refundId = `payment-refund-${randomUUID()}`;
  const reason = input.reason || "line_pay_refund_requested";
  const requestedRefundAmount = input.refundAmount ?? input.amount;

  return database.transaction(async (transaction) => {
    const capturedPayment = await findRefundablePaymentCapturePostgres(transaction, input, provider);
    if (!capturedPayment) return { error: "captured_payment_not_found" };

    const refundedAmount = await getRefundedAmountForCapturePostgres(transaction, capturedPayment.capture_id);
    // Also caps against merchant_refund_marks (the self-reported scheme-B path) -- see the matching
    // comment in merchantRefundMarkRepository.js's createRefundMarkPostgres for why both refund
    // sources must check each other's total, not just their own.
    const markRefundedAmount = await getActiveMarkTotalForOrderPostgres(transaction, capturedPayment.order_id);
    const remainingRefundableAmount = Math.max(capturedPayment.capture_amount - refundedAmount - markRefundedAmount, 0);
    const refundAmount = requestedRefundAmount == null
      ? remainingRefundableAmount
      : Number(requestedRefundAmount);
    const idempotencyKey = normalizeRefundIdempotencyKey(input.idempotencyKey)
      || buildDefaultRefundIdempotencyKey({
        provider,
        providerTransactionId: capturedPayment.provider_authorization_id,
        captureId: capturedPayment.capture_id,
        refundAmount,
        fullRefund: requestedRefundAmount == null
      });

    const existingResult = await transaction.query(
      "SELECT * FROM payment_refunds WHERE idempotency_key = $1", [idempotencyKey]
    );
    if (existingResult.rows[0]) {
      return {
        refund: mapPaymentRefund(existingResult.rows[0]),
        alreadyExists: true,
        capture: mapRefundableCaptureRow(capturedPayment),
        authorization: mapRefundableAuthorizationRow(capturedPayment),
        order: mapRefundableOrderRow(capturedPayment),
        remainingRefundableAmount,
        totalRefundedAmount: refundedAmount
      };
    }

    if (remainingRefundableAmount <= 0) {
      const latestResult = await transaction.query(`
        SELECT * FROM payment_refunds
        WHERE payment_capture_id = $1 AND status = 'refunded'
        ORDER BY refunded_at DESC, created_at DESC, id DESC
        LIMIT 1
      `, [capturedPayment.capture_id]);
      return {
        error: "already_fully_refunded",
        refund: latestResult.rows[0] ? mapPaymentRefund(latestResult.rows[0]) : null,
        capture: mapRefundableCaptureRow(capturedPayment),
        authorization: mapRefundableAuthorizationRow(capturedPayment),
        order: mapRefundableOrderRow(capturedPayment),
        remainingRefundableAmount: 0,
        totalRefundedAmount: refundedAmount
      };
    }

    if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
      return { error: "invalid_refund_amount", remainingRefundableAmount, requestedRefundAmount };
    }
    if (refundAmount > remainingRefundableAmount) {
      return {
        error: "refund_amount_exceeds_remaining_amount",
        remainingRefundableAmount,
        requestedRefundAmount: refundAmount
      };
    }

    await transaction.query(`
      INSERT INTO payment_refunds (
        id, payment_capture_id, payment_authorization_id, order_id, provider,
        status, refund_amount, idempotency_key, failure_reason, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $9)
    `, [
      refundId, capturedPayment.capture_id, capturedPayment.authorization_id,
      capturedPayment.order_id, provider, refundAmount, idempotencyKey, reason, now,
    ]);
    await insertAudit(transaction, "line_pay_refund_requested", refundId, {
      orderId: capturedPayment.order_id,
      paymentCaptureId: capturedPayment.capture_id,
      paymentAuthorizationId: capturedPayment.authorization_id,
      providerTransactionId: capturedPayment.provider_authorization_id,
      refundAmount,
      remainingRefundableAmount,
      reason,
      idempotencyKey
    }, input.actorUserId, now);

    const created = await transaction.query("SELECT * FROM payment_refunds WHERE id = $1", [refundId]);
    return {
      refund: mapPaymentRefund(created.rows[0]),
      alreadyExists: false,
      capture: mapRefundableCaptureRow(capturedPayment),
      authorization: mapRefundableAuthorizationRow(capturedPayment),
      order: mapRefundableOrderRow(capturedPayment),
      remainingRefundableAmount,
      totalRefundedAmount: refundedAmount
    };
  });
}

async function completeRefundPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();

  return database.transaction(async (transaction) => {
    const refundResult = await transaction.query(
      "SELECT * FROM payment_refunds WHERE id = $1 FOR UPDATE", [input.refundId]
    );
    const refund = refundResult.rows[0];
    if (!refund) return null;
    if (refund.status === "refunded") return buildRefundResultPostgres(transaction, refund);
    if (refund.status !== "pending") {
      return { error: "refund_not_pending", refund: mapPaymentRefund(refund) };
    }

    const captureResult = await transaction.query(
      "SELECT * FROM payment_captures WHERE id = $1 FOR UPDATE", [refund.payment_capture_id]
    );
    const capture = captureResult.rows[0];
    if (!capture || capture.status !== "captured") {
      return { error: "capture_not_refundable", refund: mapPaymentRefund(refund) };
    }

    const orderResult = await transaction.query(
      "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [refund.order_id]
    );
    const order = orderResult.rows[0];
    if (!order) return null;

    const updateResult = await transaction.query(`
      UPDATE payment_refunds
      SET status = 'refunded', provider_refund_id = $1, refunded_at = $2,
          failure_reason = NULL, updated_at = $2
      WHERE id = $3 AND status = 'pending'
      RETURNING *
    `, [input.providerRefundId || null, now, refund.id]);
    if (updateResult.rowCount !== 1) {
      return buildRefundResultPostgres(transaction, refund);
    }

    const totalRefundedAmount = await getRefundedAmountForCapturePostgres(transaction, capture.id);
    const remainingRefundableAmount = Math.max(capture.capture_amount - totalRefundedAmount, 0);
    const fullyRefunded = remainingRefundableAmount === 0;

    if (fullyRefunded) {
      const orderUpdate = await transaction.query(`
        UPDATE orders SET payment_status = 'refunded', updated_at = $1
        WHERE id = $2 AND payment_status != 'refunded'
      `, [now, refund.order_id]);
      if (orderUpdate.rowCount === 1) {
        await insertStatusHistory(transaction, "order", refund.order_id, order.payment_status,
          "refunded", "line_pay_refund_completed", input.actorUserId, now);
      }
    }

    await insertProviderEvent(transaction, refund.provider, "refund", refund.id, "refund_success",
      refund.idempotency_key ? `${refund.provider}_refund_success:${refund.idempotency_key}` : null,
      {
        orderId: refund.order_id,
        paymentCaptureId: refund.payment_capture_id,
        paymentAuthorizationId: refund.payment_authorization_id,
        refundAmount: refund.refund_amount,
        providerRefundId: input.providerRefundId || null,
        providerPayload: input.providerPayload || {}
      }, now);
    await insertAudit(transaction, "line_pay_refund_completed", refund.id, {
      orderId: refund.order_id,
      paymentCaptureId: refund.payment_capture_id,
      paymentAuthorizationId: refund.payment_authorization_id,
      refundAmount: refund.refund_amount,
      totalRefundedAmount,
      remainingRefundableAmount,
      fullyRefunded,
      providerRefundId: input.providerRefundId || null
    }, input.actorUserId, now);

    return buildRefundResultPostgres(transaction, updateResult.rows[0]);
  });
}

async function failRefundPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const reason = input.reason || "line_pay_refund_failed";

  return database.transaction(async (transaction) => {
    const refundResult = await transaction.query(
      "SELECT * FROM payment_refunds WHERE id = $1 FOR UPDATE", [input.refundId]
    );
    const refund = refundResult.rows[0];
    if (!refund) return null;
    if (refund.status !== "pending") return buildRefundResultPostgres(transaction, refund);

    const updateResult = await transaction.query(`
      UPDATE payment_refunds
      SET status = 'failed', failure_reason = $1, updated_at = $2
      WHERE id = $3 AND status = 'pending'
      RETURNING *
    `, [reason, now, refund.id]);

    await insertProviderEvent(transaction, refund.provider, "refund", refund.id, "refund_failed",
      refund.idempotency_key ? `${refund.provider}_refund_failed:${refund.idempotency_key}` : null,
      {
        orderId: refund.order_id,
        paymentCaptureId: refund.payment_capture_id,
        paymentAuthorizationId: refund.payment_authorization_id,
        refundAmount: refund.refund_amount,
        reason,
        providerPayload: input.providerPayload || {}
      }, now);
    await insertAudit(transaction, "line_pay_refund_failed", refund.id, {
      orderId: refund.order_id,
      paymentCaptureId: refund.payment_capture_id,
      paymentAuthorizationId: refund.payment_authorization_id,
      refundAmount: refund.refund_amount,
      reason,
      providerPayload: input.providerPayload || {}
    }, input.actorUserId, now);

    return buildRefundResultPostgres(transaction, updateResult.rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Merchant refund-request workflow.
// ---------------------------------------------------------------------------

async function createRefundRequestPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const requestId = `refund-request-${randomUUID()}`;

  try {
    return await database.transaction(async (transaction) => {
      const capturedPayment = await findLatestCapturedPaymentForOrderPostgres(transaction, input.orderId);
      if (!capturedPayment) return { error: "captured_payment_not_found" };
      if (input.storeId && capturedPayment.store_id !== input.storeId) {
        return { error: "order_store_mismatch" };
      }

      const idempotencyKey = normalizeRefundIdempotencyKey(input.idempotencyKey);
      if (idempotencyKey) {
        const existing = await transaction.query(
          "SELECT * FROM refund_requests WHERE idempotency_key = $1", [idempotencyKey]
        );
        if (existing.rows[0]) {
          return { refundRequest: mapRefundRequest(existing.rows[0]), alreadyExists: true };
        }
      }

      const existingPending = await transaction.query(`
        SELECT * FROM refund_requests
        WHERE payment_capture_id = $1 AND status = 'pending'
        LIMIT 1
      `, [capturedPayment.capture_id]);
      if (existingPending.rows[0]) {
        return {
          error: "refund_request_already_pending",
          refundRequest: mapRefundRequest(existingPending.rows[0])
        };
      }

      const refundedAmount = await getRefundedAmountForCapturePostgres(transaction, capturedPayment.capture_id);
      const markRefundedAmount = await getActiveMarkTotalForOrderPostgres(transaction, input.orderId);
      const remainingRefundableAmount = Math.max(capturedPayment.capture_amount - refundedAmount - markRefundedAmount, 0);
      if (remainingRefundableAmount <= 0) {
        return { error: "already_fully_refunded", remainingRefundableAmount: 0 };
      }

      const requestedAmount = Number(input.requestedAmount);
      if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
        return { error: "invalid_refund_amount", remainingRefundableAmount };
      }
      if (requestedAmount > remainingRefundableAmount) {
        return { error: "refund_amount_exceeds_remaining_amount", remainingRefundableAmount };
      }

      const reason = (input.reason || "").trim();
      if (!reason) return { error: "refund_reason_required" };

      await transaction.query(`
        INSERT INTO refund_requests (
          id, order_id, payment_capture_id, store_id, requested_by_user_id,
          requested_amount, reason, status, idempotency_key, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $9)
      `, [
        requestId, input.orderId, capturedPayment.capture_id, capturedPayment.store_id,
        input.actorUserId, requestedAmount, reason, idempotencyKey, now,
      ]);
      await insertAudit(transaction, "refund_request_created", requestId, {
        orderId: input.orderId,
        storeId: capturedPayment.store_id,
        paymentCaptureId: capturedPayment.capture_id,
        requestedAmount,
        remainingRefundableAmount,
        reason
      }, input.actorUserId, now);

      const created = await transaction.query("SELECT * FROM refund_requests WHERE id = $1", [requestId]);
      return {
        refundRequest: mapRefundRequest(created.rows[0]),
        alreadyExists: false,
        remainingRefundableAmount: remainingRefundableAmount - requestedAmount
      };
    });
  } catch (error) {
    // Two concurrent requests can both pass the SELECT-based "already pending" / idempotency
    // checks above before either commits (Postgres doesn't serialize like SQLite's whole-file
    // lock does), so the actual guard against a duplicate is these DB-level unique constraints.
    // The transaction is already rolled back by this point (database.transaction rolls back on
    // any throw), so this re-queries on a fresh connection rather than the dead transaction.
    if (error?.code === "23505" && error?.constraint === "idx_refund_requests_pending_per_capture") {
      const capturedPayment = await findLatestCapturedPaymentForOrderPostgres(database, input.orderId);
      const existingPending = capturedPayment
        ? await database.query(
            "SELECT * FROM refund_requests WHERE payment_capture_id = $1 AND status = 'pending' LIMIT 1",
            [capturedPayment.capture_id]
          )
        : { rows: [] };
      return {
        error: "refund_request_already_pending",
        refundRequest: existingPending.rows[0] ? mapRefundRequest(existingPending.rows[0]) : null
      };
    }
    if (error?.code === "23505" && error?.constraint === "refund_requests_idempotency_key_key") {
      const idempotencyKey = normalizeRefundIdempotencyKey(input.idempotencyKey);
      const existing = idempotencyKey
        ? await database.query("SELECT * FROM refund_requests WHERE idempotency_key = $1", [idempotencyKey])
        : { rows: [] };
      return {
        refundRequest: existing.rows[0] ? mapRefundRequest(existing.rows[0]) : null,
        alreadyExists: true
      };
    }
    throw error;
  }
}

async function approveRefundRequestPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();

  return database.transaction(async (transaction) => {
    const existingResult = await transaction.query(
      "SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE", [input.requestId]
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.status !== "pending") {
      return existing ? mapRefundRequest(existing) : null;
    }

    await transaction.query(`
      UPDATE refund_requests
      SET status = 'approved', reviewed_by_user_id = $1, reviewed_at = $2,
          resulting_payment_refund_id = $3, updated_at = $2
      WHERE id = $4 AND status = 'pending'
    `, [input.actorUserId || null, now, input.resultingPaymentRefundId || null, input.requestId]);
    await insertAudit(transaction, "refund_request_approved", input.requestId,
      { resultingPaymentRefundId: input.resultingPaymentRefundId || null }, input.actorUserId, now);

    const updated = await transaction.query("SELECT * FROM refund_requests WHERE id = $1", [input.requestId]);
    return mapRefundRequest(updated.rows[0]);
  });
}

async function rejectRefundRequestPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();

  return database.transaction(async (transaction) => {
    const existingResult = await transaction.query(
      "SELECT * FROM refund_requests WHERE id = $1 FOR UPDATE", [input.requestId]
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.status !== "pending") {
      return existing ? mapRefundRequest(existing) : null;
    }

    await transaction.query(`
      UPDATE refund_requests
      SET status = 'rejected', reviewed_by_user_id = $1, reviewed_at = $2,
          rejection_reason = $3, updated_at = $2
      WHERE id = $4 AND status = 'pending'
    `, [input.actorUserId || null, now, input.rejectionReason, input.requestId]);
    await insertAudit(transaction, "refund_request_rejected", input.requestId,
      { rejectionReason: input.rejectionReason }, input.actorUserId, now);

    const updated = await transaction.query("SELECT * FROM refund_requests WHERE id = $1", [input.requestId]);
    return mapRefundRequest(updated.rows[0]);
  });
}

async function getRefundRequestByIdPostgres(database, input = {}) {
  const result = await database.query("SELECT * FROM refund_requests WHERE id = $1", [input.requestId]);
  return result.rows[0] ? mapRefundRequest(result.rows[0]) : null;
}

async function listRefundRequestsForStorePostgres(database, input = {}) {
  const result = input.status
    ? await database.query(
        "SELECT * FROM refund_requests WHERE store_id = $1 AND status = $2 ORDER BY created_at DESC",
        [input.storeId, input.status]
      )
    : await database.query(
        "SELECT * FROM refund_requests WHERE store_id = $1 ORDER BY created_at DESC",
        [input.storeId]
      );
  return result.rows.map(mapRefundRequest);
}

async function listRefundRequestsForAdminPostgres(database, input = {}) {
  const result = input.status
    ? await database.query(
        "SELECT * FROM refund_requests WHERE status = $1 ORDER BY created_at DESC", [input.status]
      )
    : await database.query("SELECT * FROM refund_requests ORDER BY created_at DESC");
  return result.rows.map(mapRefundRequest);
}

// ---------------------------------------------------------------------------
// Read helpers used by the merchant refund-request approval workflow (server-side
// store-ownership check and provider resolution before dispatching the refund).
// ---------------------------------------------------------------------------

async function getOrderStoreIdPostgres(database, input = {}) {
  const result = await database.query(`
    SELECT activity.store_id AS store_id
    FROM orders
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    WHERE orders.id = $1
  `, [input.orderId]);
  return result.rows[0]?.store_id || null;
}

async function getLatestAuthorizationForOrderPostgres(database, input = {}) {
  const result = await database.query(`
    SELECT * FROM payment_authorizations
    WHERE order_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [input.orderId]);
  return result.rows[0] ? mapPaymentAuthorization(result.rows[0]) : null;
}

// Reads back a provider's raw event payload recorded earlier by
// paymentAuthorizationConfirmRepository, for a refund flow that needs a provider-specific
// field from that payload which isn't stored as its own column.
async function getLatestProviderEventPayloadPostgres(database, input = {}) {
  const result = input.eventType
    ? await database.query(`
        SELECT payload_json FROM payment_provider_events
        WHERE resource_type = $1 AND resource_id = $2 AND event_type = $3
        ORDER BY received_at DESC
        LIMIT 1
      `, [input.resourceType, input.resourceId, input.eventType])
    : await database.query(`
        SELECT payload_json FROM payment_provider_events
        WHERE resource_type = $1 AND resource_id = $2
        ORDER BY received_at DESC
        LIMIT 1
      `, [input.resourceType, input.resourceId]);
  const payload = result.rows[0]?.payload_json;
  if (!payload) return null;
  return payload?.providerPayload ?? payload;
}

// ---------------------------------------------------------------------------
// Shared query/mapping helpers.
// ---------------------------------------------------------------------------

// FOR UPDATE OF capture is load-bearing: unlike SQLite's BEGIN IMMEDIATE (which locks the
// whole database file for the transaction's duration), a Postgres transaction does not
// serialize concurrent writers on its own. Without locking the capture row here, two
// concurrent refund-creation requests against the same capture could both read the same
// "remaining refundable amount" before either commits and jointly over-refund it. This
// helper is only ever called from the mutating create-pending-refund path, so it's safe
// to always take the lock.
async function findRefundablePaymentCapturePostgres(database, input, provider) {
  // "authorization" is a reserved word in PostgreSQL (used in CREATE SCHEMA ... AUTHORIZATION)
  // and cannot be used unquoted as a table alias -- aliased as payment_auth instead, matching
  // the convention paymentCaptureRepository.js/paymentAuthorizationCancelRepository.js already use.
  const baseQuery = `
    SELECT
      capture.id AS capture_id,
      capture.payment_authorization_id AS capture_payment_authorization_id,
      capture.order_id AS capture_order_id,
      capture.status AS capture_status,
      capture.final_amount AS capture_final_amount,
      capture.capture_amount AS capture_amount,
      capture.released_amount AS capture_released_amount,
      capture.provider_capture_id,
      capture.captured_at,
      payment_auth.id AS authorization_id,
      payment_auth.order_id AS authorization_order_id,
      payment_auth.provider,
      payment_auth.payment_flow,
      payment_auth.status AS authorization_status,
      payment_auth.original_amount,
      payment_auth.authorized_amount,
      payment_auth.provider_authorization_id,
      orders.id AS order_id,
      orders.customer_user_id,
      orders.payment_status AS order_payment_status,
      orders.authorization_status AS order_authorization_status,
      orders.final_amount AS order_final_amount
    FROM payment_captures capture
    JOIN payment_authorizations payment_auth ON payment_auth.id = capture.payment_authorization_id
    JOIN orders ON orders.id = capture.order_id
    WHERE capture.status = 'captured' AND payment_auth.provider = $1
  `;

  if (input.captureId) {
    const result = await database.query(
      `${baseQuery} AND capture.id = $2 LIMIT 1 FOR UPDATE OF capture`, [provider, input.captureId]
    );
    return result.rows[0] || null;
  }
  if (input.providerTransactionId) {
    const result = await database.query(`
      ${baseQuery} AND payment_auth.provider_authorization_id = $2
      ORDER BY capture.captured_at DESC, capture.created_at DESC, capture.id DESC
      LIMIT 1
      FOR UPDATE OF capture
    `, [provider, input.providerTransactionId]);
    return result.rows[0] || null;
  }
  if (input.orderId) {
    const result = await database.query(`
      ${baseQuery} AND capture.order_id = $2
      ORDER BY capture.captured_at DESC, capture.created_at DESC, capture.id DESC
      LIMIT 1
      FOR UPDATE OF capture
    `, [provider, input.orderId]);
    return result.rows[0] || null;
  }
  return null;
}

async function findLatestCapturedPaymentForOrderPostgres(database, orderId) {
  const result = await database.query(`
    SELECT
      capture.id AS capture_id,
      capture.capture_amount,
      capture.status AS capture_status,
      orders.id AS order_id,
      orders.payment_status AS order_payment_status,
      activity.store_id AS store_id
    FROM payment_captures capture
    JOIN payment_authorizations payment_auth ON payment_auth.id = capture.payment_authorization_id
    JOIN orders ON orders.id = capture.order_id
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    WHERE capture.status = 'captured' AND capture.order_id = $1
    ORDER BY capture.captured_at DESC, capture.created_at DESC, capture.id DESC
    LIMIT 1
  `, [orderId]);
  return result.rows[0] || null;
}

async function getRefundedAmountForCapturePostgres(database, captureId) {
  const result = await database.query(`
    SELECT COALESCE(SUM(refund_amount), 0)::integer AS refunded_amount
    FROM payment_refunds
    WHERE payment_capture_id = $1 AND status = 'refunded'
  `, [captureId]);
  return Number(result.rows[0]?.refunded_amount || 0);
}

// Mirrors getRefundedAmountForCapturePostgres above, but against the OTHER refund source
// (merchant_refund_marks, scheme B's self-reported path) -- see createPendingRefundPostgres's and
// createRefundRequestPostgres's own comments on why this project's refund cap must check both.
async function getActiveMarkTotalForOrderPostgres(database, orderId) {
  const result = await database.query(`
    SELECT COALESCE(SUM(amount), 0)::integer AS active_mark_total
    FROM merchant_refund_marks
    WHERE order_id = $1 AND status = 'active'
  `, [orderId]);
  return Number(result.rows[0]?.active_mark_total || 0);
}

// NOTE: the SQLite version's buildRefundResult embeds the *full* getOrderDetail() output
// (pending revision, manual-repayment context, latest LINE Pay authorization, etc.) as
// `order`. That whole nested shape belongs to the order-revision/manual-repayment domains,
// not refunds, so porting it here would mean porting those domains too. This Postgres
// version deliberately returns a minimal order projection instead -- refund callers only
// ever read scalar order fields (status/paymentStatus/finalAmount), never the nested ones.
async function buildRefundResultPostgres(database, refund) {
  if (!refund) return null;
  const captureResult = await database.query("SELECT * FROM payment_captures WHERE id = $1", [refund.payment_capture_id]);
  const capture = captureResult.rows[0] || null;
  const totalRefundedAmount = await getRefundedAmountForCapturePostgres(database, refund.payment_capture_id);
  const remainingRefundableAmount = capture
    ? Math.max(capture.capture_amount - totalRefundedAmount, 0)
    : 0;
  const orderResult = await database.query("SELECT * FROM orders WHERE id = $1", [refund.order_id]);

  return {
    refund: mapPaymentRefund(refund),
    capture: capture ? mapPaymentCapture(capture) : null,
    order: orderResult.rows[0] ? mapMinimalOrder(orderResult.rows[0]) : null,
    status: refund.status,
    fullyRefunded: capture ? remainingRefundableAmount === 0 : false,
    totalRefundedAmount,
    remainingRefundableAmount
  };
}

async function insertProviderEvent(database, provider, resourceType, resourceId, eventType, idempotencyKey, payload, now) {
  await database.query(`
    INSERT INTO payment_provider_events (
      id, provider, resource_type, resource_id, event_type,
      idempotency_key, payload_json, received_at, processed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
    ON CONFLICT (idempotency_key) DO NOTHING
  `, [`provider-event-${randomUUID()}`, provider, resourceType, resourceId, eventType,
    idempotencyKey, JSON.stringify(payload), now]);
}

async function insertStatusHistory(database, resourceType, resourceId, fromStatus, toStatus, reason, actorUserId, now) {
  await database.query(`
    INSERT INTO status_history (
      id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [`status-history-${randomUUID()}`, resourceType, resourceId, fromStatus, toStatus, reason, actorUserId || null, now]);
}

async function insertAudit(database, actionType, resourceId, metadata, actorUserId, now) {
  const resourceType = actionType.startsWith("refund_request") ? "refund_request" : "payment_refund";
  await database.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [`audit-log-${randomUUID()}`, actorUserId || null, actionType, resourceType, resourceId, JSON.stringify(metadata), now]);
}

function normalizeRefundIdempotencyKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildDefaultRefundIdempotencyKey({ provider, providerTransactionId, captureId, refundAmount, fullRefund }) {
  const transactionPart = providerTransactionId || captureId;
  const amountPart = fullRefund ? "full" : `amount:${refundAmount}`;
  return `${provider}_refund:${transactionPart}:${amountPart}`;
}

function mapRefundableCaptureRow(row) {
  return {
    id: row.capture_id,
    paymentAuthorizationId: row.capture_payment_authorization_id,
    orderId: row.capture_order_id,
    status: row.capture_status,
    finalAmount: Number(row.capture_final_amount),
    captureAmount: Number(row.capture_amount),
    releasedAmount: Number(row.capture_released_amount),
    providerCaptureId: row.provider_capture_id,
    capturedAt: toIsoString(row.captured_at)
  };
}

function mapRefundableAuthorizationRow(row) {
  return {
    id: row.authorization_id,
    orderId: row.authorization_order_id,
    provider: row.provider,
    paymentFlow: row.payment_flow || "authorization",
    status: row.authorization_status,
    originalAmount: Number(row.original_amount),
    authorizedAmount: Number(row.authorized_amount),
    providerAuthorizationId: row.provider_authorization_id
  };
}

function mapRefundableOrderRow(row) {
  return {
    id: row.order_id,
    customerUserId: row.customer_user_id,
    paymentStatus: row.order_payment_status,
    authorizationStatus: row.order_authorization_status,
    finalAmount: row.order_final_amount == null ? null : Number(row.order_final_amount)
  };
}

function mapMinimalOrder(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    customerUserId: row.customer_user_id,
    status: row.status,
    totalCups: Number(row.total_cups),
    originalAmount: Number(row.original_amount),
    finalAmount: row.final_amount == null ? null : Number(row.final_amount),
    paymentStatus: row.payment_status,
    authorizationStatus: row.authorization_status,
    pickupStatus: row.pickup_status
  };
}

function mapPaymentRefund(row) {
  return {
    id: row.id,
    paymentCaptureId: row.payment_capture_id,
    paymentAuthorizationId: row.payment_authorization_id,
    orderId: row.order_id,
    provider: row.provider,
    status: row.status,
    refundAmount: Number(row.refund_amount),
    providerRefundId: row.provider_refund_id,
    idempotencyKey: row.idempotency_key,
    refundedAt: toIsoString(row.refunded_at),
    failureReason: row.failure_reason,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapPaymentCapture(row) {
  return {
    id: row.id,
    paymentAuthorizationId: row.payment_authorization_id,
    orderId: row.order_id,
    status: row.status,
    finalAmount: Number(row.final_amount),
    captureAmount: Number(row.capture_amount),
    releasedAmount: Number(row.released_amount),
    providerCaptureId: row.provider_capture_id,
    capturedAt: toIsoString(row.captured_at),
    failureReason: row.failure_reason,
    attemptNumber: Number(row.attempt_number),
    retryable: Boolean(row.retryable),
    nextRetryAt: toIsoString(row.next_retry_at),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapPaymentAuthorization(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderRevisionId: row.order_revision_id || null,
    provider: row.provider,
    paymentFlow: row.payment_flow || "authorization",
    status: row.status,
    originalAmount: Number(row.original_amount),
    authorizedAmount: Number(row.authorized_amount),
    providerAuthorizationId: row.provider_authorization_id,
    expiresAt: toIsoString(row.expires_at),
    authorizedAt: toIsoString(row.authorized_at),
    voidedAt: toIsoString(row.voided_at),
    failureReason: row.failure_reason,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function mapRefundRequest(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    paymentCaptureId: row.payment_capture_id,
    storeId: row.store_id,
    requestedByUserId: row.requested_by_user_id,
    requestedAmount: Number(row.requested_amount),
    reason: row.reason,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: toIsoString(row.reviewed_at),
    rejectionReason: row.rejection_reason,
    resultingPaymentRefundId: row.resulting_payment_refund_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value;
}

module.exports = {
  createPaymentRefundRepository,
  getLatestProviderEventPayloadPostgres,
  resolvePaymentRefundRuntime,
};
