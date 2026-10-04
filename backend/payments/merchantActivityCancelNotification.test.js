"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cancelMerchantGroupBuyActivity,
  buildActivityCancelledNotification
} = require("./merchantActivityCancelService");

// Same fire-and-forget as settlementService: the push call is not awaited, so let it finish first.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeCancelRepository({ activityStatus = "recruiting", orders, failOrderIds = [] }) {
  return {
    kind: "postgres",
    getActivityForCancellation: async () => ({
      id: "activity-1",
      store_id: "store-1",
      title: "手搖飲團購",
      status: activityStatus,
      deadline_at: "2099-01-01T00:00:00.000Z",
      withdrawal_lock_minutes: 30
    }),
    listEligibleOrders: async () => orders,
    cancelOrder: async ({ orderId }) => {
      if (failOrderIds.includes(orderId)) return { error: "boom" };
      return { orderId };
    },
    cancelActivityStatus: async () => ({ id: "activity-1", status: "cancelled" }),
    withOperationLock: (lockInput, operation) => operation()
  };
}

const baseInput = (repository, extra = {}) => ({
  activityId: "activity-1",
  actorUserId: "merchant-1",
  reason: "店休",
  now: "2026-10-04T00:00:00.000Z",
  canManageStore: () => true,
  merchantGroupBuyActivityCancelRepository: repository,
  paymentAuthorizationCancelRepository: undefined,
  logger: { error() {} },
  ...extra
});

test("buildActivityCancelledNotification only addresses customers whose order was really cancelled", () => {
  const notification = buildActivityCancelledNotification({
    activity: { id: "activity-1", title: "手搖飲團購" },
    eligibleOrders: [
      { id: "order-1", customer_user_id: "user-1" },
      { id: "order-2", customer_user_id: "user-1" },
      { id: "order-3", customer_user_id: "user-2" },
      { id: "order-4", customer_user_id: null }
    ],
    cancelledOrderIds: ["order-1", "order-2", "order-4"]
  });

  assert.deepEqual(notification.userIds, ["user-1"]);
  assert.equal(notification.title, "團購已取消");
  assert.match(notification.body, /手搖飲團購/);
  assert.match(notification.body, /不會扣款/);
  assert.deepEqual(notification.data, { type: "group_buy_cancelled", activityId: "activity-1" });
});

test("cancelMerchantGroupBuyActivity pushes to customers of cancelled orders but not to one whose cancel failed", async (t) => {
  const fetchCalls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200 };
  });
  const repository = fakeCancelRepository({
    orders: [
      { id: "order-1", customer_user_id: "user-ok", payment_status: "pending" },
      { id: "order-2", customer_user_id: "user-void-failed", payment_status: "pending" }
    ],
    failOrderIds: ["order-2"]
  });

  const result = await cancelMerchantGroupBuyActivity(baseInput(repository, {
    pushTokenRepository: {
      getPushTokensForUsers: async (userIds) => {
        assert.deepEqual(userIds, ["user-ok"]);
        return ["token-ok"];
      }
    }
  }));
  await flushMicrotasks();

  assert.deepEqual(result.cancelledOrderIds, ["order-1"]);
  assert.deepEqual(result.failedOrderIds, ["order-2"]);
  assert.equal(fetchCalls.length, 1);
  const [message] = JSON.parse(fetchCalls[0].options.body);
  assert.equal(message.to, "token-ok");
  assert.equal(message.data.type, "group_buy_cancelled");
});

test("cancelMerchantGroupBuyActivity sends nothing when the activity was already cancelled (idempotent retry)", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () => {
    throw new Error("fetch should not be called");
  });
  const repository = fakeCancelRepository({
    activityStatus: "cancelled",
    orders: [{ id: "order-1", customer_user_id: "user-1", payment_status: "pending" }]
  });

  const result = await cancelMerchantGroupBuyActivity(baseInput(repository, {
    pushTokenRepository: { getPushTokensForUsers: async () => ["token-a"] }
  }));
  await flushMicrotasks();

  assert.equal(result.idempotent, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("cancelMerchantGroupBuyActivity still succeeds when no push repository is wired", async () => {
  const repository = fakeCancelRepository({
    orders: [{ id: "order-1", customer_user_id: "user-1", payment_status: "pending" }]
  });

  const result = await cancelMerchantGroupBuyActivity(baseInput(repository));

  assert.deepEqual(result.cancelledOrderIds, ["order-1"]);
});
