const {
  approveRefundRequestInDatabase,
  createRefundRequestInDatabase,
  getLatestLinePayAuthorizationForOrder,
  getOrderStoreId,
  getRefundRequestById,
  rejectRefundRequestInDatabase
} = require("../db");
const { PaymentServiceError, refundLinePayPayment, refundLinePayPaymentAuthorized } = require("./linePayService");

const MAX_REFUND_REASON_LENGTH = 200;
// Outcomes of the refund call that only mean "not right now": the order's payment lock is held, or the same refund is
// already in flight. Everything else is final for this request.
const RETRY_LATER_REFUND_STATUSES = new Set(["retry_later", "refund_already_pending"]);
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

// Everything a merchant-initiated refund (request or direct) must satisfy before it touches the database:
// the merchant role, a valid amount and reason, and an order that belongs to one of the caller's own stores.
// Kept in one place so the request flow and the direct-refund flow can never drift apart on these checks.
async function resolveMerchantRefundInput({ authUser, orderId, body, paymentRefundRepository }) {
  if (!authUser?.roles?.includes("merchant")) {
    throw new PaymentServiceError(403, { error: "Merchant role required" });
  }
  if (!orderId) {
    throw new PaymentServiceError(400, { error: "Missing required field: orderId" });
  }

  const requestedAmount = body?.requestedAmount ?? body?.amount;
  if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
    throw new PaymentServiceError(400, { error: "requestedAmount must be a positive integer" });
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    throw new PaymentServiceError(400, { error: "reason is required" });
  }

  const storeId = paymentRefundRepository
    ? await paymentRefundRepository.getOrderStoreId({ orderId })
    : getOrderStoreId(orderId);
  if (!storeId) {
    throw new PaymentServiceError(404, { error: "Order not found" });
  }
  if (!authUser.merchantStores?.some((store) => store.id === storeId)) {
    throw new PaymentServiceError(403, { error: "Store access denied" });
  }

  return { storeId, requestedAmount, reason };
}

async function createMerchantRefundRequest({ authUser, orderId, body, paymentRefundRepository } = {}) {
  const { storeId, requestedAmount, reason } = await resolveMerchantRefundInput({
    authUser, orderId, body, paymentRefundRepository
  });

  const createInput = {
    orderId,
    storeId,
    requestedAmount,
    reason,
    idempotencyKey: body?.idempotencyKey,
    actorUserId: authUser.id
  };
  const result = paymentRefundRepository
    ? await paymentRefundRepository.createRefundRequest(createInput)
    : createRefundRequestInDatabase(createInput);

  if (result.error) {
    throw new PaymentServiceError(refundRequestErrorStatusCode(result.error), {
      error: refundRequestErrorMessage(result.error),
      status: result.error,
      ...result
    });
  }
  if (result.alreadyExists) {
    return { ...result, idempotent: true };
  }
  return result;
}

// Merchant direct refund (2026-10-21): a merchant refunds one of their own store's captured orders without
// waiting for an admin. The cap is the order's remaining refundable amount (checked inside the request
// creation, in a transaction, against what was already refunded). The refund request row is still written
// and kept as the ledger, so the merchant history page and the admin page keep working: it is created
// pending, the refund runs, then it is marked approved (or rejected if the provider refuses).
async function refundOrderAsMerchant({ authUser, orderId, body, paymentRefundRepository } = {}) {
  const { storeId, requestedAmount, reason } = await resolveMerchantRefundInput({
    authUser, orderId, body, paymentRefundRepository
  });
  if (reason.length > MAX_REFUND_REASON_LENGTH) {
    throw new PaymentServiceError(400, { error: `reason must be at most ${MAX_REFUND_REASON_LENGTH} characters` });
  }
  // A key is required (not optional as for requests): it is what makes a double tap or a retry after a
  // dropped connection return the first result instead of refunding twice.
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (idempotencyKey.length < MIN_IDEMPOTENCY_KEY_LENGTH || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new PaymentServiceError(400, { error: "idempotencyKey is required" });
  }

  const createInput = { orderId, storeId, requestedAmount, reason, idempotencyKey, actorUserId: authUser.id };
  const created = paymentRefundRepository
    ? await paymentRefundRepository.createRefundRequest(createInput)
    : createRefundRequestInDatabase(createInput);
  if (created.error) {
    throw new PaymentServiceError(refundRequestErrorStatusCode(created.error), {
      error: refundRequestErrorMessage(created.error),
      status: created.error,
      ...created
    });
  }

  const refundRequest = created.refundRequest;
  // The idempotency-key lookup is global, so a key that was already used by someone else (or by this merchant for
  // a different order or amount) comes back with THAT request. Only carry on when it is exactly this refund;
  // otherwise refuse without echoing the other request, so a repeated key can neither leak nor trigger another refund.
  if (
    !refundRequest
    || refundRequest.orderId !== orderId
    || refundRequest.storeId !== storeId
    || refundRequest.requestedByUserId !== authUser.id
    || refundRequest.requestedAmount !== requestedAmount
  ) {
    throw new PaymentServiceError(409, {
      error: "idempotency_key_conflict",
      status: "idempotency_key_conflict"
    });
  }
  if (created.alreadyExists && refundRequest.status === "approved") {
    return { refundRequest, idempotent: true };
  }
  if (created.alreadyExists && refundRequest.status === "rejected") {
    throw new PaymentServiceError(409, {
      error: "This refund attempt was already rejected; start a new one",
      status: "refund_request_rejected",
      refundRequest
    });
  }
  // A repeat of the same key whose request is still pending falls through and runs the refund again: the
  // refund key below is derived from the request id, so a refund that already went through is returned, not repeated.

  const refundResult = await runRefundForRequest({ authUser, refundRequest, paymentRefundRepository });

  const approveInput = {
    requestId: refundRequest.id,
    resultingPaymentRefundId: refundResult.refund?.id || null,
    actorUserId: authUser.id
  };
  const approvedRequest = paymentRefundRepository
    ? await paymentRefundRepository.approveRefundRequest(approveInput)
    : approveRefundRequestInDatabase(approveInput);

  return { refundRequest: approvedRequest, refund: refundResult };
}

// Runs the provider refund for a request. The idempotency key has the same form the admin approval uses, so
// an admin approving a request that a merchant's direct refund already refunded cannot refund it twice.
// If the refund cannot go through (the provider refused, the amount no longer fits because of a refund made in the
// meantime, ...), the request is closed as rejected so it does not block the order and the merchant can start a new
// one. Only the two "try again shortly" outcomes (an operation lock, a refund still in flight) leave it pending,
// because repeating the same call is safe and idempotent.
async function runRefundForRequest({ authUser, refundRequest, paymentRefundRepository }) {
  const authorization = paymentRefundRepository
    ? await paymentRefundRepository.getLatestAuthorizationForOrder({ orderId: refundRequest.orderId })
    : getLatestLinePayAuthorizationForOrder(refundRequest.orderId);

  try {
    return await refundLinePayPaymentAuthorized({
      authUser,
      paymentRefundRepository,
      body: {
        orderId: refundRequest.orderId,
        refundAmount: refundRequest.requestedAmount,
        idempotencyKey: `refund-request-approval:${refundRequest.id}`,
        reason: `merchant_direct_refund:${refundRequest.id}`,
        provider: authorization?.provider
      }
    });
  } catch (error) {
    if (error instanceof PaymentServiceError && !RETRY_LATER_REFUND_STATUSES.has(error.payload?.status)) {
      const rejectInput = {
        requestId: refundRequest.id,
        rejectionReason: error.payload?.status === "refund_failed" ? "金流商退款失敗，款項未退出" : "退款無法執行，款項未退出",
        actorUserId: authUser.id
      };
      if (paymentRefundRepository) await paymentRefundRepository.rejectRefundRequest(rejectInput);
      else rejectRefundRequestInDatabase(rejectInput);
    }
    throw error;
  }
}

async function approveRefundRequest({ authUser, requestId, body, paymentRefundRepository } = {}) {
  if (!authUser?.roles?.includes("admin")) {
    throw new PaymentServiceError(403, { error: "Admin role required" });
  }

  const refundRequest = paymentRefundRepository
    ? await paymentRefundRepository.getRefundRequestById({ requestId })
    : getRefundRequestById(requestId);
  if (!refundRequest) {
    throw new PaymentServiceError(404, { error: "Refund request not found" });
  }
  if (refundRequest.status !== "pending") {
    throw new PaymentServiceError(409, {
      error: `Refund request is already ${refundRequest.status}`,
      status: refundRequest.status,
      refundRequest
    });
  }

  // Resolve the provider from the order's own authorization record rather than trusting
  // a client-supplied value — an admin passing the wrong provider here would otherwise
  // call the wrong provider's refund API for a real payment.
  const authorization = paymentRefundRepository
    ? await paymentRefundRepository.getLatestAuthorizationForOrder({ orderId: refundRequest.orderId })
    : getLatestLinePayAuthorizationForOrder(refundRequest.orderId);
  const refundIdempotencyKey = body?.idempotencyKey || `refund-request-approval:${refundRequest.id}`;
  const refundReason = `refund_request_approved:${refundRequest.id}`;

  const refundResult = await refundLinePayPayment({
    authUser,
    paymentRefundRepository,
    body: {
      orderId: refundRequest.orderId,
      refundAmount: refundRequest.requestedAmount,
      idempotencyKey: refundIdempotencyKey,
      reason: refundReason,
      provider: authorization?.provider
    }
  });

  const approveInput = {
    requestId: refundRequest.id,
    resultingPaymentRefundId: refundResult.refund?.id || null,
    actorUserId: authUser.id
  };
  const approvedRequest = paymentRefundRepository
    ? await paymentRefundRepository.approveRefundRequest(approveInput)
    : approveRefundRequestInDatabase(approveInput);

  return { refundRequest: approvedRequest, refund: refundResult };
}

async function rejectRefundRequest({ authUser, requestId, body, paymentRefundRepository } = {}) {
  if (!authUser?.roles?.includes("admin")) {
    throw new PaymentServiceError(403, { error: "Admin role required" });
  }

  const refundRequest = paymentRefundRepository
    ? await paymentRefundRepository.getRefundRequestById({ requestId })
    : getRefundRequestById(requestId);
  if (!refundRequest) {
    throw new PaymentServiceError(404, { error: "Refund request not found" });
  }
  if (refundRequest.status !== "pending") {
    throw new PaymentServiceError(409, {
      error: `Refund request is already ${refundRequest.status}`,
      status: refundRequest.status,
      refundRequest
    });
  }

  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    throw new PaymentServiceError(400, { error: "reason is required" });
  }

  const rejectInput = {
    requestId: refundRequest.id,
    rejectionReason: reason,
    actorUserId: authUser.id
  };
  const rejectedRequest = paymentRefundRepository
    ? await paymentRefundRepository.rejectRefundRequest(rejectInput)
    : rejectRefundRequestInDatabase(rejectInput);

  return { refundRequest: rejectedRequest };
}

function refundRequestErrorStatusCode(error) {
  const statusCodes = {
    captured_payment_not_found: 404,
    order_store_mismatch: 403,
    already_fully_refunded: 409,
    refund_request_already_pending: 409,
    invalid_refund_amount: 400,
    refund_amount_exceeds_remaining_amount: 409,
    refund_reason_required: 400
  };
  return statusCodes[error] || 400;
}

function refundRequestErrorMessage(error) {
  const messages = {
    captured_payment_not_found: "No captured payment found for this order",
    order_store_mismatch: "Order does not belong to this store",
    already_fully_refunded: "This capture has no remaining refundable amount",
    refund_request_already_pending: "A refund request is already pending for this order",
    invalid_refund_amount: "requestedAmount must be a positive integer",
    refund_amount_exceeds_remaining_amount: "requestedAmount exceeds the remaining refundable amount",
    refund_reason_required: "reason is required"
  };
  return messages[error] || "Refund request failed";
}

module.exports = {
  approveRefundRequest,
  createMerchantRefundRequest,
  refundOrderAsMerchant,
  rejectRefundRequest
};
