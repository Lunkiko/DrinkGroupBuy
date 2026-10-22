const {
  approveRefundRequestInDatabase,
  createRefundRequestInDatabase,
  getLatestLinePayAuthorizationForOrder,
  getOrderStoreId,
  getRefundRequestById,
  rejectRefundRequestInDatabase
} = require("../db");
const { PaymentServiceError, refundLinePayPayment } = require("./linePayService");

// Everything a merchant-initiated refund request must satisfy before it touches the database:
// the merchant role, a valid amount and reason, and an order that belongs to one of the caller's own stores.
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
    // `...result` first: it carries extra fields like remainingRefundableAmount, but its own
    // `error` key is the raw machine code -- the human-readable message and `status` below must
    // come after the spread, or the spread silently overwrites them back to the raw code.
    throw new PaymentServiceError(refundRequestErrorStatusCode(result.error), {
      ...result,
      error: refundRequestErrorMessage(result.error),
      status: result.error
    });
  }
  if (result.alreadyExists) {
    return { ...result, idempotent: true };
  }
  return result;
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
  rejectRefundRequest
};
