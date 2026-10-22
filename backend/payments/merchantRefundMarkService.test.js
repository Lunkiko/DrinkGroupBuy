const assert = require("node:assert/strict");
const test = require("node:test");
const { markOrderRefundedByMerchant, revokeMerchantRefundMark } = require("./merchantRefundMarkService");
const { PaymentServiceError } = require("./linePayService");

const MERCHANT = { id: "user-m1", roles: ["merchant"], merchantStores: [{ id: "store-1" }] };
const KEY = "refund-mark-12345678";

// A fake merchantRefundMarkRepository mirroring the amount-cap and idempotency behaviour the real
// Postgres repository enforces in SQL (merchantRefundMarkRepository.js) -- this fake exists purely
// to drive the SERVICE layer's own validation and error-mapping, not to re-prove the repository's
// own concurrency/constraint guarantees (those are covered by the Postgres smoke test).
function createFakeRepository({ storeId = "store-1", remainingRefundableAmount = 100 } = {}) {
  const calls = [];
  const marksByKey = new Map(); // keyed by `${markedByUserId}:${idempotencyKey}`
  const marksById = new Map();
  let activeTotal = 0;
  let nextId = 1;

  const repository = {
    calls,
    async getOrderStoreId() {
      calls.push("getOrderStoreId");
      return storeId;
    },
    async createRefundMark(input) {
      calls.push("createRefundMark");
      const keyLookup = `${input.actorUserId}:${input.idempotencyKey}`;
      const existing = marksByKey.get(keyLookup);
      if (existing) {
        const matches = existing.orderId === input.orderId && existing.amount === input.amount;
        return matches
          ? { refundMark: existing, alreadyExists: true }
          : { error: "idempotency_key_conflict" };
      }

      const remaining = remainingRefundableAmount - activeTotal;
      if (input.amount > remaining) {
        return { error: "refund_amount_exceeds_remaining_amount", remainingRefundableAmount: Math.max(remaining, 0) };
      }

      const mark = {
        id: `mark-${nextId++}`,
        orderId: input.orderId,
        storeId: input.storeId,
        markedByUserId: input.actorUserId,
        amount: input.amount,
        reason: input.reason,
        status: "active",
        idempotencyKey: input.idempotencyKey,
        revokedAt: null,
        revokedByUserId: null,
        createdAt: new Date().toISOString()
      };
      activeTotal += input.amount;
      marksByKey.set(keyLookup, mark);
      marksById.set(mark.id, mark);
      return { refundMark: mark, alreadyExists: false, remainingRefundableAmount: remaining - input.amount };
    },
    async revokeRefundMark(input) {
      calls.push("revokeRefundMark");
      const mark = marksById.get(input.markId);
      if (!mark || (input.orderId && mark.orderId !== input.orderId) || (input.storeId && mark.storeId !== input.storeId)) {
        return { error: "refund_mark_not_found" };
      }
      if (mark.markedByUserId !== input.actorUserId) return { error: "not_mark_owner" };
      if (mark.status === "revoked") return { refundMark: mark, alreadyRevoked: true };
      if (mark.expired) return { error: "revoke_window_expired", refundMark: mark };

      mark.status = "revoked";
      mark.revokedAt = new Date().toISOString();
      mark.revokedByUserId = input.actorUserId;
      activeTotal -= mark.amount;
      return { refundMark: mark };
    },
    // Test-only helper: simulate a mark created more than 24h ago.
    expire(markId) {
      marksById.get(markId).expired = true;
    }
  };
  return repository;
}

function mark(repository, overrides = {}) {
  return markOrderRefundedByMerchant({
    authUser: MERCHANT,
    orderId: "order-1",
    body: { amount: 60, reason: "顧客反映品質異常", idempotencyKey: KEY },
    merchantRefundMarkRepository: repository,
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

test("a merchant marks their own store's order refunded", async () => {
  const repository = createFakeRepository();
  const result = await mark(repository);

  assert.equal(result.refundMark.status, "active");
  assert.equal(result.refundMark.amount, 60);
  assert.equal(result.idempotent, false);
  assert.deepEqual(repository.calls, ["getOrderStoreId", "createRefundMark"]);
});

test("only a merchant can use it, and only for their own store", async () => {
  const repository = createFakeRepository({ storeId: "store-other" });
  await rejectsWith(mark(repository), 403, /Store access denied/);
  await rejectsWith(mark(repository, { authUser: { id: "u", roles: ["customer"] } }), 403, /Merchant role required/);
  await rejectsWith(mark(repository, { authUser: { id: "u", roles: ["admin"], merchantStores: [] } }), 403, /Merchant role required/);
  assert.equal(repository.calls.includes("createRefundMark"), false);
});

test("amount must be a positive integer", async () => {
  const repository = createFakeRepository();
  await rejectsWith(mark(repository, { body: { amount: 0, reason: "x", idempotencyKey: KEY } }), 400, /amount/);
  await rejectsWith(mark(repository, { body: { amount: -5, reason: "x", idempotencyKey: KEY } }), 400, /amount/);
  await rejectsWith(mark(repository, { body: { amount: 1.5, reason: "x", idempotencyKey: KEY } }), 400, /amount/);
  await rejectsWith(mark(repository, { body: { reason: "x", idempotencyKey: KEY } }), 400, /amount/);
});

test("reason is required and capped at 200 characters", async () => {
  const repository = createFakeRepository();
  await rejectsWith(mark(repository, { body: { amount: 10, reason: "", idempotencyKey: KEY } }), 400, /reason is required/);
  await rejectsWith(mark(repository, { body: { amount: 10, reason: "   ", idempotencyKey: KEY } }), 400, /reason is required/);
  await rejectsWith(
    mark(repository, { body: { amount: 10, reason: "x".repeat(201), idempotencyKey: KEY } }),
    400,
    /at most 200 characters/
  );
});

test("idempotencyKey is required and must be 8-128 characters", async () => {
  const repository = createFakeRepository();
  await rejectsWith(mark(repository, { body: { amount: 10, reason: "x" } }), 400, /idempotencyKey/);
  await rejectsWith(mark(repository, { body: { amount: 10, reason: "x", idempotencyKey: "short" } }), 400, /idempotencyKey/);
  await rejectsWith(
    mark(repository, { body: { amount: 10, reason: "x", idempotencyKey: "x".repeat(129) } }),
    400,
    /idempotencyKey/
  );
});

test("an amount above what is still refundable is refused and nothing is marked", async () => {
  const repository = createFakeRepository({ remainingRefundableAmount: 50 });
  await rejectsWith(mark(repository), 409, /exceeds the order's remaining refundable amount/);
});

test("sending the same key twice returns the first result, not a second mark", async () => {
  const repository = createFakeRepository();
  const first = await mark(repository);
  const second = await mark(repository);

  assert.equal(first.refundMark.id, second.refundMark.id);
  assert.equal(first.idempotent, false);
  assert.equal(second.idempotent, true);
});

test("reusing the same key for a different order or amount is refused, not silently handed back", async () => {
  const repository = createFakeRepository();
  await mark(repository); // orderId "order-1", amount 60, key KEY

  await rejectsWith(
    mark(repository, { orderId: "order-2", body: { amount: 60, reason: "x", idempotencyKey: KEY } }),
    409,
    /idempotencyKey was already used for a different order or amount/
  );
  await rejectsWith(
    mark(repository, { body: { amount: 61, reason: "x", idempotencyKey: KEY } }),
    409,
    /idempotencyKey was already used for a different order or amount/
  );
});

test("a merchant revokes their own mark within the window", async () => {
  const repository = createFakeRepository();
  const created = await mark(repository);

  const result = await revokeMerchantRefundMark({
    authUser: MERCHANT,
    orderId: "order-1",
    markId: created.refundMark.id,
    merchantRefundMarkRepository: repository
  });

  assert.equal(result.refundMark.status, "revoked");
  assert.equal(result.alreadyRevoked, false);
});

test("only the merchant who marked it can revoke it", async () => {
  const repository = createFakeRepository();
  const created = await mark(repository);

  await rejectsWith(
    revokeMerchantRefundMark({
      authUser: { id: "user-m2", roles: ["merchant"], merchantStores: [{ id: "store-1" }] },
      orderId: "order-1",
      markId: created.refundMark.id,
      merchantRefundMarkRepository: repository
    }),
    403,
    /Only the merchant who marked this refund can revoke it/
  );
});

test("revoking an already-revoked mark is idempotent, not an error", async () => {
  const repository = createFakeRepository();
  const created = await mark(repository);
  const revokeOnce = () => revokeMerchantRefundMark({
    authUser: MERCHANT, orderId: "order-1", markId: created.refundMark.id, merchantRefundMarkRepository: repository
  });

  const first = await revokeOnce();
  const second = await revokeOnce();
  assert.equal(first.alreadyRevoked, false);
  assert.equal(second.alreadyRevoked, true);
});

test("a mark past the 24-hour window cannot be revoked", async () => {
  const repository = createFakeRepository();
  const created = await mark(repository);
  repository.expire(created.refundMark.id);

  await rejectsWith(
    revokeMerchantRefundMark({
      authUser: MERCHANT, orderId: "order-1", markId: created.refundMark.id, merchantRefundMarkRepository: repository
    }),
    409,
    /24-hour window/
  );
});

test("revoking a mark from a different order or store 404s instead of confirming it exists", async () => {
  const repository = createFakeRepository();
  const created = await mark(repository);

  await rejectsWith(
    revokeMerchantRefundMark({
      authUser: MERCHANT, orderId: "order-other", markId: created.refundMark.id, merchantRefundMarkRepository: repository
    }),
    404,
    /Refund mark not found/
  );
});

test("revoking a mark that doesn't exist 404s", async () => {
  const repository = createFakeRepository();
  await rejectsWith(
    revokeMerchantRefundMark({
      authUser: MERCHANT, orderId: "order-1", markId: "no-such-mark", merchantRefundMarkRepository: repository
    }),
    404,
    /Refund mark not found/
  );
});
