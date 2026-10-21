"use strict";

// Scheme B self-reported refund (2026-10-21): the merchant and customer settle the refund
// themselves; this never calls a provider. It only records what the merchant says happened and
// lets them undo that record within 24 hours. See docs/payment-rules-and-flow.md "退款" long-term
// direction section for the full rule set this implements.

const { PaymentServiceError } = require("./linePayService");

const MAX_REFUND_REASON_LENGTH = 200;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

async function markOrderRefundedByMerchant({ authUser, orderId, body, merchantRefundMarkRepository } = {}) {
  requireMerchant(authUser);
  if (!orderId) {
    throw new PaymentServiceError(400, { error: "Missing required field: orderId" });
  }

  const amount = body?.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentServiceError(400, { error: "amount must be a positive integer" });
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    throw new PaymentServiceError(400, { error: "reason is required" });
  }
  if (reason.length > MAX_REFUND_REASON_LENGTH) {
    throw new PaymentServiceError(400, { error: `reason must be at most ${MAX_REFUND_REASON_LENGTH} characters` });
  }

  const idempotencyKey = requireIdempotencyKey(body?.idempotencyKey);

  const storeId = await resolveOwnedStoreId({ authUser, orderId, merchantRefundMarkRepository });

  const result = await merchantRefundMarkRepository.createRefundMark({
    orderId, storeId, amount, reason, idempotencyKey, actorUserId: authUser.id
  });
  if (result.error) {
    // `...result` first: it carries extra fields like remainingRefundableAmount, but its own
    // `error` key is the raw machine code (e.g. "refund_amount_exceeds_remaining_amount") -- the
    // human-readable message and `status` below must come after the spread, not before, or the
    // spread silently overwrites them back to the raw code.
    throw new PaymentServiceError(markErrorStatusCode(result.error), {
      ...result,
      error: markErrorMessage(result.error),
      status: result.error
    });
  }
  return { refundMark: result.refundMark, idempotent: Boolean(result.alreadyExists) };
}

async function revokeMerchantRefundMark({ authUser, orderId, markId, merchantRefundMarkRepository } = {}) {
  requireMerchant(authUser);
  if (!orderId || !markId) {
    throw new PaymentServiceError(400, { error: "Missing required field: orderId and markId" });
  }

  const storeId = await resolveOwnedStoreId({ authUser, orderId, merchantRefundMarkRepository });

  const result = await merchantRefundMarkRepository.revokeRefundMark({
    markId, orderId, storeId, actorUserId: authUser.id
  });
  if (result.error) {
    throw new PaymentServiceError(revokeErrorStatusCode(result.error), {
      ...result,
      error: revokeErrorMessage(result.error),
      status: result.error
    });
  }
  return { refundMark: result.refundMark, alreadyRevoked: Boolean(result.alreadyRevoked) };
}

function requireMerchant(authUser) {
  if (!authUser?.roles?.includes("merchant")) {
    throw new PaymentServiceError(403, { error: "Merchant role required" });
  }
}

function requireIdempotencyKey(value) {
  const idempotencyKey = typeof value === "string" ? value.trim() : "";
  if (idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new PaymentServiceError(400, { error: "idempotencyKey is required" });
  }
  return idempotencyKey;
}

async function resolveOwnedStoreId({ authUser, orderId, merchantRefundMarkRepository }) {
  const storeId = await merchantRefundMarkRepository.getOrderStoreId({ orderId });
  if (!storeId) {
    throw new PaymentServiceError(404, { error: "Order not found" });
  }
  if (!authUser.merchantStores?.some((store) => store.id === storeId)) {
    throw new PaymentServiceError(403, { error: "Store access denied" });
  }
  return storeId;
}

function markErrorStatusCode(error) {
  const statusCodes = {
    order_not_found: 404,
    order_not_captured: 409,
    order_store_mismatch: 403,
    invalid_refund_amount: 400,
    refund_amount_exceeds_remaining_amount: 409,
    refund_reason_required: 400,
    idempotency_key_required: 400,
    idempotency_key_conflict: 409
  };
  return statusCodes[error] || 400;
}

function markErrorMessage(error) {
  const messages = {
    order_not_found: "Order not found",
    order_not_captured: "This order has no captured payment to refund",
    order_store_mismatch: "Order does not belong to this store",
    idempotency_key_conflict: "This idempotencyKey was already used for a different order or amount",
    invalid_refund_amount: "amount must be a positive integer",
    refund_amount_exceeds_remaining_amount: "amount exceeds the order's remaining refundable amount",
    refund_reason_required: "reason is required",
    idempotency_key_required: "idempotencyKey is required"
  };
  return messages[error] || "Marking this refund failed";
}

function revokeErrorStatusCode(error) {
  const statusCodes = {
    refund_mark_not_found: 404,
    not_mark_owner: 403,
    revoke_window_expired: 409
  };
  return statusCodes[error] || 400;
}

function revokeErrorMessage(error) {
  const messages = {
    refund_mark_not_found: "Refund mark not found",
    not_mark_owner: "Only the merchant who marked this refund can revoke it",
    revoke_window_expired: "This refund mark can no longer be revoked (past the 24-hour window)"
  };
  return messages[error] || "Revoking this refund mark failed";
}

module.exports = {
  markOrderRefundedByMerchant,
  revokeMerchantRefundMark,
};
