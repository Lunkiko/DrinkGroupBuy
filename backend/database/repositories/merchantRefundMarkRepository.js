"use strict";

const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("..");

// Scheme B self-reported refund (2026-10-21): Postgres-only from day one, same reasoning as
// merchantApplicationRepository.js -- there is no legacy SQLite implementation to preserve (this
// table didn't exist before this feature), and this project's runtime has already permanently
// switched to PostgreSQL (see AGENTS.md). See docs/payment-rules-and-flow.md "退款" for the
// business rules this repository enforces.
function createMerchantRefundMarkRepository(input = {}) {
  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    getOrderStoreId: (value) => getOrderStoreIdPostgres(database, value),
    createRefundMark: (value) => createRefundMarkPostgres(database, value),
    revokeRefundMark: (value) => revokeRefundMarkPostgres(database, value),
    getActiveRefundTotalForOrder: (value) => getActiveRefundTotalForOrderPostgres(database, value),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

const REVOKE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function createRefundMarkPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const markId = `refund-mark-${randomUUID()}`;
  const idempotencyKey = normalizeKey(input.idempotencyKey);
  if (!idempotencyKey) return { error: "idempotency_key_required" };

  try {
    return await database.transaction(async (transaction) => {
      // Scoped per merchant (marked_by_user_id, idempotency_key), not globally, so this lookup
      // must include the actor -- see the table's migration comment for why.
      const existing = await transaction.query(
        "SELECT * FROM merchant_refund_marks WHERE marked_by_user_id = $1 AND idempotency_key = $2",
        [input.actorUserId, idempotencyKey]
      );
      if (existing.rows[0]) {
        return { refundMark: mapRefundMark(existing.rows[0]), alreadyExists: true };
      }

      // Locks the order row for the rest of this transaction. This is what actually serializes
      // two concurrent marks against the same order -- the amount-sum check below reads every
      // other active mark for this order, and unlike the idempotency key above there is no unique
      // index that could catch a race on its own; a second transaction's FOR UPDATE on this same
      // row blocks until this one commits or rolls back. Other payment-lifecycle operations
      // (capture/void/refund) take the same lock on the same row (paymentRefundRepository.js,
      // paymentCaptureRepository.js), so this also correctly serializes against those, not just
      // against other marks.
      const orderResult = await transaction.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [input.orderId]);
      const order = orderResult.rows[0];
      if (!order) return { error: "order_not_found" };
      if (order.payment_status !== "captured" || order.final_amount == null) {
        return { error: "order_not_captured" };
      }

      const storeResult = await transaction.query(
        "SELECT store_id FROM group_buy_activities WHERE id = $1", [order.activity_id]
      );
      const orderStoreId = storeResult.rows[0]?.store_id || null;
      if (input.storeId && orderStoreId !== input.storeId) {
        return { error: "order_store_mismatch" };
      }

      const amount = Number(input.amount);
      if (!Number.isInteger(amount) || amount <= 0) return { error: "invalid_refund_amount" };

      const reason = (input.reason || "").trim();
      if (!reason) return { error: "refund_reason_required" };

      const activeTotalResult = await transaction.query(`
        SELECT COALESCE(SUM(amount), 0)::integer AS active_total
        FROM merchant_refund_marks
        WHERE order_id = $1 AND status = 'active'
      `, [input.orderId]);
      const activeTotalBefore = Number(activeTotalResult.rows[0]?.active_total || 0);
      const remainingBefore = Number(order.final_amount) - activeTotalBefore;
      if (amount > remainingBefore) {
        return {
          error: "refund_amount_exceeds_remaining_amount",
          remainingRefundableAmount: Math.max(remainingBefore, 0)
        };
      }

      await transaction.query(`
        INSERT INTO merchant_refund_marks (
          id, order_id, store_id, marked_by_user_id, amount, reason, status, idempotency_key, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $8)
      `, [markId, input.orderId, orderStoreId, input.actorUserId, amount, reason, idempotencyKey, now]);
      await insertAudit(transaction, "merchant_refund_mark_created", markId, {
        orderId: input.orderId,
        storeId: orderStoreId,
        amount,
        reason,
        remainingRefundableAmountBefore: remainingBefore
      }, input.actorUserId, now);

      const created = await transaction.query("SELECT * FROM merchant_refund_marks WHERE id = $1", [markId]);
      return {
        refundMark: mapRefundMark(created.rows[0]),
        alreadyExists: false,
        remainingRefundableAmount: remainingBefore - amount
      };
    });
  } catch (error) {
    // Same reasoning as createRefundRequestPostgres's equivalent catch (paymentRefundRepository.js):
    // two concurrent retries of the same key can both pass the in-transaction SELECT above before
    // either commits. The unique constraint is the real guard; this recovers the row it kept.
    if (error?.code === "23505" && error?.constraint === "merchant_refund_marks_idempotency_key_unique") {
      const existing = await database.query(
        "SELECT * FROM merchant_refund_marks WHERE marked_by_user_id = $1 AND idempotency_key = $2",
        [input.actorUserId, idempotencyKey]
      );
      return {
        refundMark: existing.rows[0] ? mapRefundMark(existing.rows[0]) : null,
        alreadyExists: true
      };
    }
    throw error;
  }
}

async function revokeRefundMarkPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();

  return database.transaction(async (transaction) => {
    const markResult = await transaction.query(
      "SELECT * FROM merchant_refund_marks WHERE id = $1 FOR UPDATE", [input.markId]
    );
    const mark = markResult.rows[0];
    // A markId that exists but belongs to a different order/store than the caller's URL is treated
    // the same as "not found" rather than confirming it exists under the wrong order -- this is a
    // sub-resource of orderId (/orders/:orderId/refund-marks/:markId), so a mismatch here is either
    // a client bug (wrong orderId) or someone probing with a markId that isn't theirs to touch.
    if (!mark || (input.orderId && mark.order_id !== input.orderId)) return { error: "refund_mark_not_found" };
    if (input.storeId && mark.store_id !== input.storeId) return { error: "refund_mark_not_found" };
    if (mark.marked_by_user_id !== input.actorUserId) return { error: "not_mark_owner" };
    if (mark.status === "revoked") return { refundMark: mapRefundMark(mark), alreadyRevoked: true };

    const createdAtMs = new Date(mark.created_at).getTime();
    if (Date.parse(now) - createdAtMs > REVOKE_WINDOW_MS) {
      return { error: "revoke_window_expired", refundMark: mapRefundMark(mark) };
    }

    const updateResult = await transaction.query(`
      UPDATE merchant_refund_marks
      SET status = 'revoked', revoked_at = $1, revoked_by_user_id = $2, updated_at = $1
      WHERE id = $3 AND status = 'active'
      RETURNING *
    `, [now, input.actorUserId, mark.id]);
    if (updateResult.rowCount !== 1) {
      // Lost a race with another revoke of the same mark between the SELECT above and this UPDATE.
      const refreshed = await transaction.query("SELECT * FROM merchant_refund_marks WHERE id = $1", [mark.id]);
      return { refundMark: mapRefundMark(refreshed.rows[0]), alreadyRevoked: true };
    }

    await insertAudit(transaction, "merchant_refund_mark_revoked", mark.id, {
      orderId: mark.order_id,
      storeId: mark.store_id,
      amount: Number(mark.amount)
    }, input.actorUserId, now);

    return { refundMark: mapRefundMark(updateResult.rows[0]) };
  });
}

async function getActiveRefundTotalForOrderPostgres(database, input = {}) {
  const result = await database.query(`
    SELECT COALESCE(SUM(amount), 0)::integer AS active_total
    FROM merchant_refund_marks
    WHERE order_id = $1 AND status = 'active'
  `, [input.orderId]);
  return Number(result.rows[0]?.active_total || 0);
}

async function getOrderStoreIdPostgres(database, input = {}) {
  const result = await database.query(`
    SELECT activity.store_id AS store_id
    FROM orders
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    WHERE orders.id = $1
  `, [input.orderId]);
  return result.rows[0]?.store_id || null;
}

async function insertAudit(database, actionType, resourceId, metadata, actorUserId, now) {
  await database.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
    ) VALUES ($1, $2, $3, 'merchant_refund_mark', $4, $5::jsonb, $6)
  `, [`audit-log-${randomUUID()}`, actorUserId || null, actionType, resourceId, JSON.stringify(metadata), now]);
}

function normalizeKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function mapRefundMark(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    storeId: row.store_id,
    markedByUserId: row.marked_by_user_id,
    amount: Number(row.amount),
    reason: row.reason,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    revokedAt: toIsoString(row.revoked_at),
    revokedByUserId: row.revoked_by_user_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value;
}

module.exports = {
  createMerchantRefundMarkRepository,
};
