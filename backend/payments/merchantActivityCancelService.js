const { voidLinePayAuthorization } = require("./linePayService");
const { notifyUsers } = require("../notifications/pushSender");

const ACTIVITY_LOCK_MINUTES_DEFAULT = 30;
const ORDER_LOCK_LEASE_MS = 300_000;

async function cancelMerchantOrder({
  order,
  activityId,
  actorUserId,
  reason,
  now,
  merchantGroupBuyActivityCancelRepository,
  paymentAuthorizationCancelRepository
}) {
  const idempotencyKey = `merchant-cancel-activity-${activityId}-order-${order.id}`;
  const orderCancelOperation = async () => {
    if (order.payment_status === "authorized") {
      await voidLinePayAuthorization({
        orderId: order.id,
        provider: order.payment_provider || "line_pay",
        reason: "merchant_cancelled_group_buy_activity",
        authorizationCancelRepository: paymentAuthorizationCancelRepository,
        operationLockHeld: paymentAuthorizationCancelRepository?.kind === "postgres"
      });
    }
    const cancelResult = await merchantGroupBuyActivityCancelRepository.cancelOrder({
      activityId,
      orderId: order.id,
      actorUserId,
      idempotencyKey,
      reason,
      now
    });
    if (cancelResult.error) {
      throw new Error(cancelResult.error);
    }
    return cancelResult;
  };

  return merchantGroupBuyActivityCancelRepository.withOperationLock(
    { orderId: order.id, leaseMs: ORDER_LOCK_LEASE_MS, now },
    orderCancelOperation
  );
}

async function cancelMerchantGroupBuyActivity(input = {}) {
  const now = input.now || new Date().toISOString();
  const merchantGroupBuyActivityCancelRepository = input.merchantGroupBuyActivityCancelRepository;
  const paymentAuthorizationCancelRepository = input.paymentAuthorizationCancelRepository;
  const logger = input.logger || console;

  const activity = await merchantGroupBuyActivityCancelRepository.getActivityForCancellation({
    activityId: input.activityId,
    now
  });
  if (!activity) return { error: "activity_not_found" };
  if (!input.canManageStore(activity.store_id)) return { error: "store_access_denied" };
  if (activity.status === "cancelled") {
    return {
      activity: await merchantGroupBuyActivityCancelRepository.cancelActivityStatus({
        activityId: input.activityId,
        now
      }),
      cancelledOrderIds: [],
      cancelledOrderCount: 0,
      failedOrderIds: [],
      idempotent: true
    };
  }
  // Admin cancel (input.unconditional) bypasses both the "recruiting only" and deadline-lock
  // guards below -- it's an explicit operator override for stuck/in-progress group buys, not a
  // merchant self-service action, so the protections that exist to stop a merchant backing out
  // on customers right before a deadline don't apply. Orders that already captured payment stay
  // untouched either way (listEligibleOrders excludes captured/refunded) -- refunding those is a
  // separate, deliberate action through the refund-request flow, not bundled into this cascade.
  if (!input.unconditional) {
    if (activity.status !== "recruiting") {
      return { error: "activity_not_cancellable", status: activity.status };
    }

    const deadline = Date.parse(activity.deadline_at);
    const lockMinutes = Number(activity.withdrawal_lock_minutes ?? ACTIVITY_LOCK_MINUTES_DEFAULT);
    if (!Number.isNaN(deadline) && deadline - Date.parse(now) <= lockMinutes * 60_000) {
      return { error: "activity_locked_by_deadline", deadlineAt: activity.deadline_at, lockMinutes };
    }
  }

  const eligibleOrders = await merchantGroupBuyActivityCancelRepository.listEligibleOrders({
    activityId: input.activityId
  });

  const orderResults = await Promise.allSettled(eligibleOrders.map((order) => cancelMerchantOrder({
    order,
    activityId: input.activityId,
    actorUserId: input.actorUserId,
    reason: input.reason,
    now,
    merchantGroupBuyActivityCancelRepository,
    paymentAuthorizationCancelRepository
  })));

  const cancelledOrderIds = [];
  const failedOrderIds = [];
  orderResults.forEach((result, index) => {
    const order = eligibleOrders[index];
    if (result.status === "fulfilled") {
      cancelledOrderIds.push(order.id);
      return;
    }
    logger.error?.("[merchant-cancel-activity] order cancel failed", {
      activityId: input.activityId,
      orderId: order.id,
      message: result.reason?.message,
      stack: result.reason?.stack
    });
    failedOrderIds.push(order.id);
  });

  const activityResult = await merchantGroupBuyActivityCancelRepository.cancelActivityStatus({
    activityId: input.activityId,
    reason: input.reason,
    actorUserId: input.actorUserId,
    now,
    actionType: input.actionType || "merchant_cancel_group_buy_activity"
  });

  // Not awaited: notifyUsers never throws (see ../notifications/pushSender.js), and the merchant or
  // admin waiting on this cancellation shouldn't be blocked on an Expo push round-trip. Only orders
  // that were really cancelled are told "no charge" -- an order whose void failed (failedOrderIds)
  // may still hold an authorization, so it gets no message rather than a wrong one.
  if (!activityResult?.error) {
    const notification = buildActivityCancelledNotification({ activity, eligibleOrders, cancelledOrderIds });
    if (notification.userIds.length > 0) {
      notifyUsers(notification, {
        pushTokenRepository: input.pushTokenRepository,
        logger
      }).catch((error) => {
        logger.error?.("[push-notification] failed to notify group buy cancelled", {
          activityId: input.activityId,
          message: error.message
        });
      });
    }
  }

  return {
    activity: activityResult,
    cancelledOrderIds,
    cancelledOrderCount: cancelledOrderIds.length,
    failedOrderIds
  };
}

// Pure and side-effect-free so the audience and wording are unit-testable without a database or
// the Expo push call. Orders that already captured payment never reach `eligibleOrders` (see
// listEligibleOrders), so this never claims "no charge" to someone who was charged.
function buildActivityCancelledNotification({ activity, eligibleOrders, cancelledOrderIds }) {
  const cancelled = new Set(cancelledOrderIds);
  const userIds = [...new Set(
    eligibleOrders
      .filter((order) => cancelled.has(order.id))
      .map((order) => order.customer_user_id)
      .filter(Boolean)
  )];
  return {
    userIds,
    title: "團購已取消",
    body: `${activity.title || "你參加的團購"}已被取消，你的訂單不會扣款`,
    data: { type: "group_buy_cancelled", activityId: activity.id }
  };
}

module.exports = {
  cancelMerchantGroupBuyActivity,
  buildActivityCancelledNotification
};
