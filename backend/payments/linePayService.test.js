"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { resolveLinePayAccountOverrides, refundLinePayPayment } = require("./linePayService");

// Fake repository mirroring storePaymentAccountRepository.js's shape, just enough to drive
// resolveLinePayAccountOverrides's own branching -- the repository's real SQL is covered by
// scripts/store-payment-account-postgres-smoke.js against real Postgres.
function createFakeRepository({ storeId = "store-with-account", account = null } = {}) {
  const calls = [];
  return {
    calls,
    async getOrderStoreId(input) {
      calls.push(["getOrderStoreId", input]);
      return input.orderId === "order-no-store" ? null : storeId;
    },
    async getActiveAccountForStore(input) {
      calls.push(["getActiveAccountForStore", input]);
      return account;
    },
  };
}

test("provider other than line_pay never queries the repository", async () => {
  const repository = createFakeRepository();
  const result = await resolveLinePayAccountOverrides({
    orderId: "order-1", provider: "mock_line_pay", storePaymentAccountRepository: repository,
  });
  assert.deepEqual(result, {});
  assert.deepEqual(repository.calls, []);
});

test("no repository injected falls back to {} without throwing", async () => {
  const result = await resolveLinePayAccountOverrides({ orderId: "order-1", provider: "line_pay" });
  assert.deepEqual(result, {});
});

test("no orderId falls back to {} without querying", async () => {
  const repository = createFakeRepository();
  const result = await resolveLinePayAccountOverrides({
    provider: "line_pay", storePaymentAccountRepository: repository,
  });
  assert.deepEqual(result, {});
  assert.deepEqual(repository.calls, []);
});

test("an order whose store can't be resolved falls back to {}", async () => {
  const repository = createFakeRepository();
  const result = await resolveLinePayAccountOverrides({
    orderId: "order-no-store", provider: "line_pay", storePaymentAccountRepository: repository,
  });
  assert.deepEqual(result, {});
});

test("a store with no account row yet falls back to {} -- the global env default, not an error", async () => {
  const repository = createFakeRepository({ account: null });
  const result = await resolveLinePayAccountOverrides({
    orderId: "order-1", provider: "line_pay", storePaymentAccountRepository: repository,
  });
  assert.deepEqual(result, {});
});

test("a store with an active account gets back exactly its own credentials", async () => {
  const repository = createFakeRepository({
    storeId: "store-42",
    account: { channelId: "channel-42", channelSecret: "secret-42" },
  });
  const result = await resolveLinePayAccountOverrides({
    orderId: "order-1", provider: "line_pay", storePaymentAccountRepository: repository,
  });
  assert.deepEqual(result, { channelId: "channel-42", channelSecret: "secret-42" });
  assert.deepEqual(repository.calls, [
    ["getOrderStoreId", { orderId: "order-1" }],
    ["getActiveAccountForStore", { storeId: "store-42", provider: "line_pay" }],
  ]);
});

// Security review (2026-10-22): a refund keyed by captureId/providerTransactionId must use the
// CAPTURE's real store's account, not body.orderId -- the request body's orderId is unvalidated
// when the refund is looked up by captureId instead, and can name a different order/store than the
// capture actually being refunded.
test("a refund keyed by captureId uses the capture's real store's account, not body.orderId's", async () => {
  const storePaymentAccountRepository = (() => {
    const calls = [];
    const accountsByStore = {
      "store-A-wrong": { channelId: "channel-A", channelSecret: "secret-A" },
      "store-B-real": { channelId: "channel-B", channelSecret: "secret-B" },
    };
    const storeByOrder = { "order-A-wrong": "store-A-wrong", "order-B-real": "store-B-real" };
    return {
      calls,
      async getOrderStoreId(input) {
        calls.push(["getOrderStoreId", input]);
        return storeByOrder[input.orderId];
      },
      async getActiveAccountForStore(input) {
        calls.push(["getActiveAccountForStore", input]);
        return accountsByStore[input.storeId];
      },
    };
  })();

  const paymentRefundRepository = {
    kind: "postgres",
    withOperationLock: (input, operation) => operation(),
    async createPendingRefund() {
      return {
        refund: { id: "refund-1", refundAmount: 30 },
        alreadyExists: false,
        capture: { id: "capture-B" },
        authorization: { orderId: "order-B-real", providerAuthorizationId: "txn-123" },
        order: { id: "order-B-real" },
        remainingRefundableAmount: 70,
        totalRefundedAmount: 0,
      };
    },
    async completeRefund() {
      return { refund: { id: "refund-1", status: "refunded", refundAmount: 30 } };
    },
  };

  const providerCalls = [];
  const providerRefunder = async (transactionId, input, accountOverrides) => {
    providerCalls.push({ transactionId, input, accountOverrides });
    return { info: { refundTransactionId: "r1", refundTransactionDate: "now", refundAmount: 30 } };
  };

  await refundLinePayPayment({
    authUser: { id: "admin-1", roles: ["admin"] },
    body: { captureId: "capture-B", orderId: "order-A-wrong" },
    paymentRefundRepository,
    storePaymentAccountRepository,
    providerRefunder,
  });

  assert.deepEqual(providerCalls[0].accountOverrides, { channelId: "channel-B", channelSecret: "secret-B" });
  assert.deepEqual(
    storePaymentAccountRepository.calls.find(([name]) => name === "getOrderStoreId"),
    ["getOrderStoreId", { orderId: "order-B-real" }],
    "must resolve the store from the capture's real order, not body.orderId"
  );
});
