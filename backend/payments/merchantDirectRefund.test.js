const assert = require("node:assert/strict");
const test = require("node:test");
const { refundOrderAsMerchant } = require("./refundRequestService");
const { PaymentServiceError } = require("./linePayService");

const MERCHANT = { id: "user-m1", roles: ["merchant"], merchantStores: [{ id: "store-1" }] };
const KEY = "refund-key-12345678";

// A fake paymentRefundRepository. It claims to be the Postgres kind so the service takes the repository's own
// operation lock (run inline here) instead of the SQLite lock in db.js, which would write to the dev database.
// `captureAmount` is what the capture can still refund; the real repository enforces the cap in SQL, the fake mirrors it.
function createFakeRepository({ storeId = "store-1", captureAmount = 100, provider = "mock_line_pay" } = {}) {
  const calls = [];
  const requests = new Map();
  const repository = {
    kind: "postgres",
    calls,
    requests,
    async withOperationLock(_lockInput, operation) {
      return operation();
    },
    async getOrderStoreId() {
      calls.push("getOrderStoreId");
      return storeId;
    },
    async createRefundRequest(input) {
      calls.push("createRefundRequest");
      const existing = [...requests.values()].find((request) => request.idempotencyKey === input.idempotencyKey);
      if (existing) return { refundRequest: existing, alreadyExists: true };
      if (input.requestedAmount > captureAmount) {
        return { error: "refund_amount_exceeds_remaining_amount", remainingRefundableAmount: captureAmount };
      }
      const refundRequest = {
        id: `rr-${requests.size + 1}`,
        orderId: input.orderId,
        storeId: input.storeId,
        requestedByUserId: input.actorUserId,
        requestedAmount: input.requestedAmount,
        reason: input.reason,
        status: "pending",
        idempotencyKey: input.idempotencyKey
      };
      requests.set(refundRequest.id, refundRequest);
      return { refundRequest, alreadyExists: false };
    },
    async getLatestAuthorizationForOrder() {
      return { provider };
    },
    async createPendingRefund(input) {
      calls.push(`createPendingRefund:${input.refundAmount}:${input.idempotencyKey}`);
      return {
        refund: { id: "refund-1", refundAmount: input.refundAmount, status: "pending" },
        authorization: { providerAuthorizationId: "tx-1" }
      };
    },
    async completeRefund(input) {
      calls.push("completeRefund");
      return { refund: { id: input.refundId, status: "refunded" } };
    },
    async failRefund(input) {
      calls.push("failRefund");
      return { refund: { id: input.refundId, status: "failed" } };
    },
    async approveRefundRequest(input) {
      calls.push("approveRefundRequest");
      const request = requests.get(input.requestId);
      request.status = "approved";
      request.resultingPaymentRefundId = input.resultingPaymentRefundId;
      return request;
    },
    async rejectRefundRequest(input) {
      calls.push("rejectRefundRequest");
      const request = requests.get(input.requestId);
      request.status = "rejected";
      request.rejectionReason = input.rejectionReason;
      return request;
    }
  };
  return repository;
}

function refund(repository, overrides = {}) {
  return refundOrderAsMerchant({
    authUser: MERCHANT,
    orderId: "order-1",
    body: { requestedAmount: 60, reason: "製作錯誤", idempotencyKey: KEY },
    paymentRefundRepository: repository,
    ...overrides
  });
}

async function rejectsWith(promise, statusCode, errorText) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof PaymentServiceError, `expected PaymentServiceError, got ${error}`);
    assert.equal(error.statusCode, statusCode);
    if (errorText) assert.match(error.payload.error, errorText);
    return true;
  });
}

test("a merchant refunds their own store's order in one step and the request ends approved", async () => {
  const repository = createFakeRepository();
  const result = await refund(repository);

  assert.equal(result.refundRequest.status, "approved");
  assert.equal(result.refundRequest.resultingPaymentRefundId, "refund-1");
  assert.deepEqual(repository.calls.filter((call) => !call.startsWith("getOrderStoreId")), [
    "createRefundRequest",
    "createPendingRefund:60:refund-request-approval:rr-1",
    "completeRefund",
    "approveRefundRequest"
  ]);
});

test("only a merchant can use it, and only for their own store", async () => {
  const repository = createFakeRepository({ storeId: "store-other" });
  await rejectsWith(refund(repository), 403, /Store access denied/);
  await rejectsWith(refund(repository, { authUser: { id: "u", roles: ["customer"] } }), 403, /Merchant role required/);
  await rejectsWith(refund(repository, { authUser: { id: "u", roles: ["admin"], merchantStores: [] } }), 403, /Merchant role required/);
  assert.equal(repository.calls.some((call) => call.startsWith("createRefundRequest")), false);
});

test("bad input is refused before anything is written", async () => {
  const repository = createFakeRepository();
  for (const body of [
    { requestedAmount: 0, reason: "x", idempotencyKey: KEY },
    { requestedAmount: -5, reason: "x", idempotencyKey: KEY },
    { requestedAmount: 12.5, reason: "x", idempotencyKey: KEY },
    { requestedAmount: "60", reason: "x", idempotencyKey: KEY },
    { requestedAmount: 60, reason: "   ", idempotencyKey: KEY },
    { requestedAmount: 60, reason: "x".repeat(201), idempotencyKey: KEY },
    { requestedAmount: 60, reason: "x" },
    { requestedAmount: 60, reason: "x", idempotencyKey: "short" }
  ]) {
    await rejectsWith(refund(repository, { body }), 400);
  }
  assert.equal(repository.calls.some((call) => call.startsWith("createRefundRequest")), false);
});

test("an amount above what is still refundable is refused and nothing is refunded", async () => {
  const repository = createFakeRepository({ captureAmount: 50 });
  await rejectsWith(refund(repository), 409, /refund_amount_exceeds_remaining_amount/);
  assert.equal(repository.calls.some((call) => call.startsWith("createPendingRefund")), false);
  assert.equal(repository.requests.size, 0);
});

test("sending the same key twice returns the first result and refunds once", async () => {
  const repository = createFakeRepository();
  const first = await refund(repository);
  const second = await refund(repository);

  assert.equal(first.refundRequest.status, "approved");
  assert.equal(second.idempotent, true);
  assert.equal(repository.calls.filter((call) => call.startsWith("createPendingRefund")).length, 1);
});

test("a key already used for another order, amount or merchant is refused and nothing is refunded", async () => {
  const repository = createFakeRepository();
  await refund(repository);
  const refundsBefore = repository.calls.filter((call) => call.startsWith("createPendingRefund")).length;

  // Same key, different order / different amount / a different merchant of the same store.
  await rejectsWith(refund(repository, { orderId: "order-2" }), 409, /idempotency_key_conflict/);
  await rejectsWith(
    refund(repository, { body: { requestedAmount: 61, reason: "製作錯誤", idempotencyKey: KEY } }),
    409,
    /idempotency_key_conflict/
  );
  await rejectsWith(
    refund(repository, { authUser: { ...MERCHANT, id: "user-m2" } }),
    409,
    /idempotency_key_conflict/
  );

  // A pending request left by someone else must not be picked up and refunded by the repeat of its key.
  const [stolen] = repository.requests.values();
  stolen.status = "pending";
  await rejectsWith(refund(repository, { authUser: { ...MERCHANT, id: "user-m2" } }), 409, /idempotency_key_conflict/);
  assert.equal(repository.calls.filter((call) => call.startsWith("createPendingRefund")).length, refundsBefore);
});

test("a key whose earlier attempt was rejected is refused, a new key starts a fresh attempt", async () => {
  const repository = createFakeRepository();
  const first = await refund(repository);
  first.refundRequest.status = "rejected";

  await rejectsWith(refund(repository), 409, /already rejected/);
  const retry = await refund(repository, {
    body: { requestedAmount: 60, reason: "製作錯誤", idempotencyKey: "refund-key-87654321" }
  });
  assert.equal(retry.refundRequest.status, "approved");
});

test("a refund that can no longer succeed closes the request; a lock leaves it pending for a retry", async () => {
  // The amount stops fitting between creating the request and running the refund (e.g. a refund made in between).
  const closed = createFakeRepository();
  closed.createPendingRefund = async () => ({ error: "refund_amount_exceeds_remaining_amount", remainingRefundableAmount: 10 });
  await rejectsWith(refund(closed), 409);
  assert.equal(closed.requests.get("rr-1").status, "rejected");

  // The order's payment lock is held: nothing was decided, the same call can be repeated.
  const locked = createFakeRepository();
  locked.withOperationLock = async () => {
    const error = new Error("locked");
    error.code = "operation_locked";
    throw error;
  };
  await rejectsWith(refund(locked), 409, /payment_operation_locked/);
  assert.equal(locked.requests.get("rr-1").status, "pending");
  assert.equal(locked.calls.includes("rejectRefundRequest"), false);
});

test("if the provider refuses, the request is rejected so the merchant can try again", async () => {
  // A real (not mock) provider with no LINE Pay credentials configured fails before any network call.
  const saved = {};
  for (const name of ["LINE_PAY_CHANNEL_ID", "LINE_PAY_CHANNEL_SECRET"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    const repository = createFakeRepository({ provider: "line_pay" });
    await rejectsWith(refund(repository), 502, /LINE Pay refund failed/);

    assert.equal(repository.requests.get("rr-1").status, "rejected");
    assert.ok(repository.calls.includes("failRefund"));
    assert.equal(repository.calls.includes("approveRefundRequest"), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
