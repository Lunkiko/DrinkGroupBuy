"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { settleGroupBuyActivity, buildGroupBuyQualifiedNotification, buildSettlementNotifications } = require("./settlementService");

// The notification call is deliberately fire-and-forget (not awaited) so a slow/unavailable Expo
// push API can't add latency to the settlement caller's response -- see settlementService.js's
// comment at the notifyUsers(...) call site. Tests that assert on the resulting fetch call need to
// let that background promise chain finish first; setImmediate yields past the microtask queue.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("buildGroupBuyQualifiedNotification collects deduped customer ids and includes the activity title", () => {
  const plan = {
    activity: { id: "activity-1", title: "手搖飲團購" },
    orders: [
      { id: "order-1", customerUserId: "user-1", action: "already_captured" },
      { id: "order-2", customerUserId: "user-2", action: "already_captured" },
      { id: "order-3", customerUserId: "user-1", action: "already_captured" },
      { id: "order-4", customerUserId: null, action: "already_captured" },
    ],
  };

  const notification = buildGroupBuyQualifiedNotification(plan, []);

  assert.deepEqual(notification.userIds, ["user-1", "user-2"]);
  assert.equal(notification.title, "團購成團囉！");
  assert.match(notification.body, /手搖飲團購/);
  assert.deepEqual(notification.data, { type: "group_buy_qualified", activityId: "activity-1" });
});

test("buildGroupBuyQualifiedNotification falls back to generic wording when the activity has no title", () => {
  const notification = buildGroupBuyQualifiedNotification({
    activity: { id: "activity-1" },
    orders: [{ id: "order-1", customerUserId: "user-1", action: "already_captured" }],
  }, []);

  assert.match(notification.body, /你參加的團購/);
});

test("buildGroupBuyQualifiedNotification excludes a customer whose capture terminally failed", () => {
  // A qualified settlement can still have individual orders whose capture retries exhausted --
  // those land in `results` with status "failed" (not the separate `failures` array, which would
  // have aborted the whole settlement before reaching this point). That customer was never
  // actually charged and must not be told "團購成團囉，請留意取貨通知".
  const plan = {
    activity: { id: "activity-1", title: "手搖飲團購" },
    orders: [
      { id: "order-1", customerUserId: "user-paid-earlier", action: "already_captured" },
      { id: "order-2", customerUserId: "user-captured-now", action: "capture" },
      { id: "order-3", customerUserId: "user-capture-failed", action: "capture" },
    ],
  };
  const results = [
    { orderId: "order-1", action: "already_captured", status: "skipped" },
    { orderId: "order-2", action: "capture", status: "captured" },
    { orderId: "order-3", action: "capture", status: "failed", reason: "capture_retry_exhausted" },
  ];

  const notification = buildGroupBuyQualifiedNotification(plan, results);

  assert.deepEqual(notification.userIds, ["user-paid-earlier", "user-captured-now"]);
});

test("settleGroupBuyActivity notifies every distinct customer when the activity qualifies", async (t) => {
  const fetchCalls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200 };
  });

  const plan = {
    activity: { id: "activity-1", title: "手搖飲團購" },
    outcome: "qualified",
    orders: [
      { id: "order-1", customerUserId: "user-1", action: "already_captured", actionReason: "already_captured" },
      { id: "order-2", customerUserId: "user-2", action: "already_captured", actionReason: "already_captured" },
    ],
  };
  const settlementRepository = {
    kind: "postgres",
    withOperationLock: (lockInput, operation) => operation(),
    createPlan: async () => plan,
    completeSettlement: async () => (
      { settlement: { id: "settlement-1" }, activity: { ...plan.activity, status: "ordering" } }
    ),
  };

  const result = await settleGroupBuyActivity({
    activityId: "activity-1",
    settlementRepository,
    pushTokenRepository: {
      getPushTokensForUsers: async (userIds) => {
        assert.deepEqual(userIds, ["user-1", "user-2"]);
        return ["token-a", "token-b"];
      },
    },
  });
  await flushMicrotasks();

  assert.equal(result.error, undefined);
  assert.equal(fetchCalls.length, 1);
  const messages = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(messages.map((message) => message.to), ["token-a", "token-b"]);
  assert.match(messages[0].body, /手搖飲團購/);
});

test("settleGroupBuyActivity does not notify a customer whose order's capture terminally failed", async (t) => {
  const fetchCalls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200 };
  });

  const plan = {
    activity: { id: "activity-1", title: "手搖飲團購" },
    outcome: "qualified",
    orders: [
      { id: "order-1", customerUserId: "user-paid", action: "already_captured", actionReason: "already_captured" },
      { id: "order-2", customerUserId: "user-declined", action: "capture", actionReason: "deadline_settlement_capture" },
    ],
  };
  const settlementRepository = {
    kind: "postgres",
    withOperationLock: (lockInput, operation) => operation(),
    createPlan: async () => plan,
    // order-2's capture is exhausted (non-retryable) -- lands in `results` with status "failed",
    // not in the separate `failures` array, so settlement still completes and would otherwise
    // notify this customer too.
    getCaptureRetryState: async () => ({ exhausted: true, attemptCount: 3, maxAttempts: 3 }),
    // completeSettlement doesn't know per-order outcomes -- the important thing here is that
    // settleGroupBuyActivityUnlocked's own `results` array (built from each order's actual
    // capture attempt) is what buildGroupBuyQualifiedNotification is filtered against, not `plan`.
    completeSettlement: async () => (
      { settlement: { id: "settlement-1" }, activity: { ...plan.activity, status: "ordering" } }
    ),
  };
  const paymentCaptureRepository = {
    recordCaptureFailure: async () => ({ attemptCount: 3, maxAttempts: 3 }),
  };

  const result = await settleGroupBuyActivity({
    activityId: "activity-1",
    settlementRepository,
    paymentCaptureRepository,
    // Each distinct message looks up its own audience: the paid customer hears "qualified", the one
    // whose capture failed hears "capture failed" -- and never the other way round.
    pushTokenRepository: {
      getPushTokensForUsers: async (userIds) => {
        if (userIds.includes("user-paid")) {
          assert.deepEqual(userIds, ["user-paid"]);
          return ["token-paid"];
        }
        assert.deepEqual(userIds, ["user-declined"]);
        return ["token-declined"];
      },
    },
  });
  await flushMicrotasks();

  assert.equal(result.error, undefined);
  assert.equal(fetchCalls.length, 2);
  const messagesByType = Object.fromEntries(fetchCalls.map((call) => {
    const [message] = JSON.parse(call.options.body);
    return [message.data.type, message];
  }));
  assert.equal(messagesByType.group_buy_qualified.to, "token-paid");
  assert.equal(messagesByType.payment_capture_failed.to, "token-declined");
});

test("settleGroupBuyActivity does not notify when a retried job finds the settlement already completed", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () => {
    throw new Error("fetch should not be called");
  });

  const plan = {
    activity: { id: "activity-1", title: "手搖飲團購" },
    outcome: "qualified",
    orders: [
      { id: "order-1", customerUserId: "user-1", action: "already_captured", actionReason: "already_captured" },
    ],
  };
  const settlementRepository = {
    kind: "postgres",
    withOperationLock: (lockInput, operation) => operation(),
    createPlan: async () => plan,
    completeSettlement: async () => ({ settlement: { id: "settlement-1" }, alreadyCompleted: true }),
  };

  await settleGroupBuyActivity({
    activityId: "activity-1",
    settlementRepository,
    pushTokenRepository: { getPushTokensForUsers: async () => ["token-a"] },
  });
  await flushMicrotasks();

  assert.equal(fetchMock.mock.callCount(), 0);
});

test("settleGroupBuyActivity sends nothing when a failed activity has no voided, original-price or failed-capture orders", async (t) => {
  const fetchMock = t.mock.method(global, "fetch", async () => {
    throw new Error("fetch should not be called");
  });

  const plan = {
    activity: { id: "activity-1", title: "手搖飲團購" },
    outcome: "failed",
    orders: [
      { id: "order-1", customerUserId: "user-1", action: "already_captured", actionReason: "already_captured" },
    ],
  };
  const settlementRepository = {
    kind: "postgres",
    withOperationLock: (lockInput, operation) => operation(),
    createPlan: async () => plan,
    completeSettlement: async () => (
      { settlement: { id: "settlement-1" }, activity: { ...plan.activity, status: "failed" } }
    ),
  };

  await settleGroupBuyActivity({
    activityId: "activity-1",
    settlementRepository,
    pushTokenRepository: { getPushTokensForUsers: async () => ["token-a"] },
  });
  await flushMicrotasks();

  assert.equal(fetchMock.mock.callCount(), 0);
});


const notificationPlan = (outcome) => ({
  outcome,
  activity: { id: "activity-1", title: "手搖飲團購" },
  orders: [
    { id: "order-void-1", customerUserId: "user-void-1", action: "void" },
    { id: "order-void-2", customerUserId: "user-void-1", action: "void" },
    { id: "order-original", customerUserId: "user-original", action: "capture" },
    { id: "order-failed", customerUserId: "user-failed", action: "capture" },
    { id: "order-paid-earlier", customerUserId: "user-paid-earlier", action: "already_captured" },
  ],
});

test("buildSettlementNotifications tells voided customers 'not charged' and fallback buyers 'bought at original price' when the group fails", () => {
  const results = [
    { orderId: "order-void-1", action: "void", status: "authorization_voided" },
    { orderId: "order-void-2", action: "void", status: "authorization_voided" },
    { orderId: "order-original", action: "capture", status: "captured" },
    { orderId: "order-failed", action: "capture", status: "failed" },
    { orderId: "order-paid-earlier", action: "already_captured", status: "skipped" },
  ];

  const notifications = buildSettlementNotifications(notificationPlan("failed"), results);
  const byType = Object.fromEntries(notifications.map((notification) => [notification.data.type, notification]));

  assert.deepEqual(Object.keys(byType).sort(), [
    "group_buy_not_qualified",
    "group_buy_original_price_purchase",
    "payment_capture_failed",
  ]);
  assert.deepEqual(byType.group_buy_not_qualified.userIds, ["user-void-1"]);
  assert.match(byType.group_buy_not_qualified.body, /不會扣款/);
  assert.deepEqual(byType.group_buy_original_price_purchase.userIds, ["user-original"]);
  assert.deepEqual(byType.payment_capture_failed.userIds, ["user-failed"]);
  assert.ok(!byType.group_buy_qualified, "a failed group must never say it qualified");
});

test("buildSettlementNotifications for a qualified group sends the qualified message and a separate capture-failure message", () => {
  const results = [
    { orderId: "order-original", action: "capture", status: "captured" },
    { orderId: "order-failed", action: "capture", status: "failed" },
    { orderId: "order-paid-earlier", action: "already_captured", status: "skipped" },
  ];

  const notifications = buildSettlementNotifications(notificationPlan("qualified"), results);
  const byType = Object.fromEntries(notifications.map((notification) => [notification.data.type, notification]));

  assert.deepEqual(byType.group_buy_qualified.userIds.sort(), ["user-original", "user-paid-earlier"]);
  assert.deepEqual(byType.payment_capture_failed.userIds, ["user-failed"]);
  assert.ok(!byType.group_buy_not_qualified && !byType.group_buy_original_price_purchase);
});

test("buildSettlementNotifications drops empty audiences", () => {
  const notifications = buildSettlementNotifications(notificationPlan("failed"), []);
  assert.deepEqual(notifications, []);
});

test("buildSettlementNotifications uses the orders' final state, so customers handled by an earlier retry run are still told", () => {
  // This run's results only cover order D; A/B were voided and C was charged by an earlier run and
  // are therefore absent from both `plan` and `results`. They come from finalOrders.
  const plan = { outcome: "failed", activity: { id: "activity-1", title: "手搖飲團購" }, orders: [{ id: "order-d", customerUserId: "user-d", action: "capture" }] };
  const results = [{ orderId: "order-d", action: "capture", status: "captured" }];
  const finalOrders = [
    { id: "order-a", customerUserId: "user-a", paymentStatus: "authorization_voided", fallbackPurchasePreference: "decline_original_price" },
    { id: "order-b", customerUserId: "user-b", paymentStatus: "authorization_voided", fallbackPurchasePreference: "decline_original_price" },
    { id: "order-c", customerUserId: "user-c", paymentStatus: "captured", fallbackPurchasePreference: "accept_original_price" },
    { id: "order-d", customerUserId: "user-d", paymentStatus: "captured", fallbackPurchasePreference: "accept_original_price" },
  ];

  const byType = Object.fromEntries(
    buildSettlementNotifications(plan, results, finalOrders).map((notification) => [notification.data.type, notification])
  );

  assert.deepEqual(byType.group_buy_not_qualified.userIds, ["user-a", "user-b"]);
  assert.deepEqual(byType.group_buy_original_price_purchase.userIds, ["user-c", "user-d"]);
});

test("settleGroupBuyActivity reads final order outcomes for a failed activity and falls back to this run's results if that read fails", async (t) => {
  const fetchCalls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    fetchCalls.push(JSON.parse(options.body)[0]);
    return { ok: true, status: 200 };
  });
  const plan = { activity: { id: "activity-1", title: "手搖飲團購" }, outcome: "failed", orders: [] };
  const baseRepository = {
    kind: "postgres",
    withOperationLock: (lockInput, operation) => operation(),
    createPlan: async () => plan,
    completeSettlement: async () => ({ settlement: { id: "settlement-1" }, activity: { ...plan.activity, status: "failed" } }),
  };

  await settleGroupBuyActivity({
    activityId: "activity-1",
    settlementRepository: {
      ...baseRepository,
      listSettlementOutcomeOrders: async ({ activityId }) => {
        assert.equal(activityId, "activity-1");
        return [{ id: "order-a", customerUserId: "user-a", paymentStatus: "authorization_voided", fallbackPurchasePreference: "decline_original_price" }];
      },
    },
    pushTokenRepository: { getPushTokensForUsers: async (userIds) => userIds.map((id) => `token-${id}`) },
  });
  await flushMicrotasks();
  assert.deepEqual(fetchCalls.map((message) => [message.to, message.data.type]), [["token-user-a", "group_buy_not_qualified"]]);

  fetchCalls.length = 0;
  await settleGroupBuyActivity({
    activityId: "activity-1",
    settlementRepository: { ...baseRepository, listSettlementOutcomeOrders: async () => { throw new Error("db down"); } },
    pushTokenRepository: { getPushTokensForUsers: async () => ["token-x"] },
    logger: { error() {} },
  });
  await flushMicrotasks();
  assert.deepEqual(fetchCalls, [], "falls back to this run's (empty) results without throwing");
});
