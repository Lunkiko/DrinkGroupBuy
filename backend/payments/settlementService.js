const { randomUUID } = require("node:crypto");
const {
  acquireOperationLock,
  captureLinePayAuthorizationInDatabase,
  claimPaymentReliabilityJobs,
  completeGroupBuySettlement,
  completePaymentReliabilityJob,
  createGroupBuySettlementPlan,
  enqueuePaymentReliabilityJob,
  getLinePayCaptureRetryState,
  listDueGroupBuyActivitiesForSettlement,
  recordLinePayCaptureFailureInDatabase,
  releaseOperationLock,
  reschedulePaymentReliabilityJob
} = require("../db");
const {
  captureLinePayAuthorization,
  getLinePayCaptureProviderState,
  voidLinePayAuthorization
} = require("./linePayService");
const { sendPaymentReliabilityJobAlert, sendSchedulerFailureAlert } = require("./alertNotifier");
const { notifyUsers } = require("../notifications/pushSender");

const CAPTURE_MAX_ATTEMPTS = 3;
const CAPTURE_RETRY_INTERVAL_MS = 30_000;

async function settleGroupBuyActivity(input = {}) {
  if (input.settlementRepository?.kind === "postgres") {
    return input.settlementRepository.withOperationLock({
      ...input,
      now: undefined,
    }, () => (
      settleGroupBuyActivityUnlocked(input)
    ));
  }
  const ownerId = input.lockOwnerId || `settlement-${process.pid}-${randomUUID()}`;
  const lockKey = `settlement:activity:${input.activityId}`;
  const lock = acquireOperationLock({
    lockKey,
    ownerId,
    leaseMs: input.leaseMs || 300_000
  });
  if (!lock.acquired) {
    return {
      error: "settlement_locked",
      activityId: input.activityId,
      lockedUntil: lock.lockedUntil
    };
  }
  try {
    return await settleGroupBuyActivityUnlocked(input);
  } finally {
    releaseOperationLock({ lockKey, ownerId });
  }
}

async function settleGroupBuyActivityUnlocked(input = {}) {
  const {
    activityId,
    actorUserId,
    force = false,
    now,
    settlementRepository,
    paymentCaptureRepository,
    authorizationCancelRepository
  } = input;
  const planInput = { activityId, actorUserId, force, now };
  const plan = settlementRepository
    ? await settlementRepository.createPlan(planInput)
    : createGroupBuySettlementPlan(activityId, { actorUserId, force, now });

  if (!plan || plan.error) {
    return plan;
  }

  const results = [];
  const failures = [];
  const pendingRetries = [];

  for (const order of plan.orders) {
    if (order.action === "already_captured") {
      results.push({
        orderId: order.id,
        action: order.action,
        status: "skipped",
        reason: order.actionReason
      });
      continue;
    }

    if (order.action === "error_missing_authorization") {
      failures.push({
        orderId: order.id,
        action: order.action,
        error: order.actionReason
      });
      continue;
    }

    try {
      if (order.action === "capture") {
        const retryInput = {
          orderId: order.id,
          providerTransactionId: order.providerTransactionId,
          provider: order.paymentProvider,
          maxAttempts: CAPTURE_MAX_ATTEMPTS,
          now
        };
        const retryState = settlementRepository
          ? await settlementRepository.getCaptureRetryState(retryInput)
          : getLinePayCaptureRetryState(retryInput);
        if (retryState?.exhausted) {
          const failureInput = {
            orderId: order.id,
            providerTransactionId: order.providerTransactionId,
            provider: order.paymentProvider,
            amount: order.captureAmount,
            finalAmount: order.finalAmount,
            reason: "capture_retry_exhausted",
            retryable: false,
            maxAttempts: CAPTURE_MAX_ATTEMPTS,
            retryIntervalMs: CAPTURE_RETRY_INTERVAL_MS
          };
          const stopped = paymentCaptureRepository
            ? await paymentCaptureRepository.recordCaptureFailure(failureInput)
            : recordLinePayCaptureFailureInDatabase(failureInput);
          results.push(createTerminalCaptureFailureResult(order, stopped || retryState, "capture_retry_exhausted"));
          continue;
        }
        if (retryState && retryState.attemptCount > 0 && !retryState.retryDue) {
          pendingRetries.push({
            orderId: order.id,
            action: "capture",
            attemptCount: retryState.attemptCount,
            nextRetryAt: retryState.nextRetryAt
          });
          continue;
        }

        if (retryState && retryState.attemptCount > 0) {
          const providerState = await getLinePayCaptureProviderState({
            orderId: order.id,
            transactionId: order.providerTransactionId,
            provider: order.paymentProvider,
            paymentCaptureRepository
          });
          if (providerState.state === "captured") {
            const reconciliationInput = {
              orderId: order.id,
              providerTransactionId: order.providerTransactionId,
              provider: order.paymentProvider,
              providerCaptureId: order.providerTransactionId,
              amount: order.captureAmount,
              finalAmount: order.finalAmount,
              reason: "line_pay_provider_capture_reconciled",
              providerPayload: providerState.payload
            };
            const reconciled = paymentCaptureRepository
              ? await paymentCaptureRepository.captureAuthorization(reconciliationInput)
              : captureLinePayAuthorizationInDatabase(reconciliationInput);
            results.push({
              orderId: order.id,
              action: "capture",
              status: "captured",
              capture: reconciled?.capture || null,
              reconciled: true
            });
            continue;
          }
          if (providerState.state === "unknown") {
            pendingRetries.push({
              orderId: order.id,
              action: "capture",
              attemptCount: retryState.attemptCount,
              nextRetryAt: new Date(Date.now() + CAPTURE_RETRY_INTERVAL_MS).toISOString(),
              reason: "capture_provider_state_unknown"
            });
            continue;
          }
          if (!["authorized", "not_captured"].includes(providerState.state)) {
            const failureInput = {
              orderId: order.id,
              providerTransactionId: order.providerTransactionId,
              provider: order.paymentProvider,
              amount: order.captureAmount,
              finalAmount: order.finalAmount,
              reason: `capture_retry_provider_${providerState.state}`,
              retryable: false,
              maxAttempts: CAPTURE_MAX_ATTEMPTS,
              retryIntervalMs: CAPTURE_RETRY_INTERVAL_MS,
              providerPayload: providerState.payload
            };
            const stopped = paymentCaptureRepository
              ? await paymentCaptureRepository.recordCaptureFailure(failureInput)
              : recordLinePayCaptureFailureInDatabase(failureInput);
            results.push(createTerminalCaptureFailureResult(
              order,
              stopped,
              `capture_retry_provider_${providerState.state}`
            ));
            continue;
          }
        }

        const captureResult = await captureLinePayAuthorization({
          orderId: order.id,
          transactionId: order.providerTransactionId,
          provider: order.paymentProvider,
          amount: order.captureAmount,
          finalAmount: order.finalAmount,
          reason: `deadline_settlement_${order.actionReason}`,
          paymentCaptureRepository
        });

        results.push({
          orderId: order.id,
          action: "capture",
          status: captureResult?.status || "captured",
          capture: captureResult?.capture || null
        });
        continue;
      }

      const voidResult = await voidLinePayAuthorization({
        orderId: order.id,
        transactionId: order.providerTransactionId,
        provider: order.paymentProvider,
        reason: `deadline_settlement_${order.actionReason}`,
        authorizationCancelRepository
      });

      results.push({
        orderId: order.id,
        action: "void",
        status: voidResult?.status || "authorization_voided",
        authorization: voidResult?.authorization || null
      });
    } catch (error) {
      const captureFailure = error.captureFailure;
      if (order.action === "capture" && captureFailure) {
        if (captureFailure.retryable && captureFailure.attemptCount < CAPTURE_MAX_ATTEMPTS) {
          pendingRetries.push({
            orderId: order.id,
            action: "capture",
            attemptCount: captureFailure.attemptCount,
            nextRetryAt: captureFailure.nextRetryAt,
            error: error.linePayPayload || { message: error.message }
          });
        } else {
          results.push(createTerminalCaptureFailureResult(
            order,
            captureFailure,
            error.captureClassification?.reason || "capture_retry_exhausted"
          ));
        }
        continue;
      }

      failures.push({
        orderId: order.id,
        action: order.action,
        error: error.payload || { message: error.message }
      });
    }
  }

  if (failures.length > 0) {
    return {
      error: "settlement_payment_failures",
      plan,
      results,
      failures
    };
  }

  if (pendingRetries.length > 0) {
    return {
      error: "settlement_retry_pending",
      plan,
      results,
      pendingRetries
    };
  }

  const capturedOrderCount = plan.orders.filter((order) => order.action === "already_captured").length
    + results.filter((result) => result.action === "capture" && result.status === "captured").length;
  const voidedOrderCount = results
    .filter((result) => result.action === "void" && result.status === "authorization_voided")
    .length;
  const failedOrderCount = results
    .filter((result) => result.action === "capture" && result.status === "failed")
    .length;
  const completionInput = {
    activityId,
    actorUserId,
    outcome: plan.outcome,
    authorizedCups: plan.authorizedCups,
    appliedTierId: plan.appliedTier?.id || null,
    discountPercent: plan.discountPercent,
    totalDiscountAmount: plan.totalDiscountAmount,
    discountFunder: plan.discountFunder,
    capturedOrderCount,
    voidedOrderCount,
    failedOrderCount,
    reason: failedOrderCount > 0
      ? "deadline_settlement_completed_with_payment_failures"
      : "deadline_settlement_completed",
    now
  };
  const completion = settlementRepository
    ? await settlementRepository.completeSettlement(completionInput)
    : completeGroupBuySettlement(activityId, completionInput);

  // Only the run that actually just completed the settlement should notify -- a retried job that
  // finds the settlement already recorded (completion.alreadyCompleted) already sent this once.
  // Not awaited: notifyUsers never throws (see pushSender.js), and the merchant/admin waiting on
  // this settlement's HTTP response shouldn't be blocked on an Expo push round-trip (up to 5s).
  if (!completion?.error && !completion?.alreadyCompleted) {
    for (const notification of buildSettlementNotifications(plan, results)) {
      notifyUsers(notification, {
        pushTokenRepository: input.pushTokenRepository,
        logger: input.logger,
      }).catch((error) => {
        (input.logger || console).error?.("[push-notification] failed to notify settlement outcome", {
          activityId,
          type: notification.data?.type,
          message: error.message,
        });
      });
    }
  }

  return {
    plan,
    results,
    capturedOrderCount,
    voidedOrderCount,
    failedOrderCount,
    settlement: completion?.settlement || null,
    activity: completion?.activity || null
  };
}

// Pure and side-effect-free on purpose so the notification content itself (who gets notified,
// what it says) is unit-testable without mocking the database or the Expo push call.
// `results` (this run's actual per-order capture/void outcomes) is required, not just `plan`
// (what settlement intended to do): a qualified settlement can still have individual orders whose
// capture terminally failed (see createTerminalCaptureFailureResult) -- those go into `results`
// with status "failed", not into the separate `failures` array that would have aborted the whole
// settlement, so without this filter a customer who was never actually charged would still be told
// "團購成團囉，請留意取貨通知". Uses the same "really captured" definition as capturedOrderCount above.
function buildGroupBuyQualifiedNotification(plan, results) {
  const capturedOrderIds = new Set([
    ...(plan.orders || [])
      .filter((order) => order.action === "already_captured")
      .map((order) => order.id),
    ...(results || [])
      .filter((result) => result.action === "capture" && result.status === "captured")
      .map((result) => result.orderId),
  ]);
  const customerUserIds = [...new Set(
    (plan.orders || [])
      .filter((order) => capturedOrderIds.has(order.id))
      .map((order) => order.customerUserId)
      .filter(Boolean)
  )];
  return {
    userIds: customerUserIds,
    title: "團購成團囉！",
    body: `${plan.activity?.title || "你參加的團購"}已達成團門檻，請留意取貨通知`,
    data: { type: "group_buy_qualified", activityId: plan.activity?.id },
  };
}

// Every settlement outcome a customer's money depends on, as a list of notifications -- one per
// distinct message, so each audience gets wording that matches what actually happened to their order:
//   - qualified            : charged at the discounted price (buildGroupBuyQualifiedNotification)
//   - not qualified, void  : pre-authorization released, never charged
//   - not qualified, capture : charged at the original price because they opted into that fallback
//   - capture failed       : the charge was attempted and terminally failed (either outcome)
// Each audience is built only from this run's actual per-order results, never from `plan` alone, for
// the same reason as buildGroupBuyQualifiedNotification above. Empty audiences are dropped.
function buildSettlementNotifications(plan, results) {
  const activityTitle = plan.activity?.title || "你參加的團購";
  const activityId = plan.activity?.id;
  const customerByOrderId = new Map((plan.orders || []).map((order) => [order.id, order.customerUserId]));
  const customerIdsFor = (matchesResult) => [...new Set(
    (results || [])
      .filter(matchesResult)
      .map((result) => customerByOrderId.get(result.orderId))
      .filter(Boolean)
  )];

  const notifications = [];
  if (plan.outcome === "qualified") {
    notifications.push(buildGroupBuyQualifiedNotification(plan, results));
  } else {
    notifications.push({
      userIds: customerIdsFor((result) => result.action === "void" && result.status === "authorization_voided"),
      title: "團購未成團",
      body: `${activityTitle}未達成團門檻，已取消預授權，不會扣款`,
      data: { type: "group_buy_not_qualified", activityId },
    });
    notifications.push({
      userIds: customerIdsFor((result) => result.action === "capture" && result.status === "captured"),
      title: "團購未達優惠門檻",
      body: `${activityTitle}未達優惠門檻，已依你的設定以原價購買，請留意取貨通知`,
      data: { type: "group_buy_original_price_purchase", activityId },
    });
  }
  notifications.push({
    userIds: customerIdsFor((result) => result.action === "capture" && result.status === "failed"),
    title: "訂單扣款失敗",
    body: `${activityTitle}的訂單扣款失敗，請到「我的訂單」查看並處理`,
    data: { type: "payment_capture_failed", activityId },
  });
  return notifications.filter((notification) => notification.userIds.length > 0);
}

function createTerminalCaptureFailureResult(order, retryState, reason) {
  return {
    orderId: order.id,
    action: "capture",
    status: "failed",
    reason,
    attemptCount: retryState?.attemptCount || 0,
    maxAttempts: retryState?.maxAttempts || CAPTURE_MAX_ATTEMPTS,
    retryable: false,
    capture: retryState?.capture || retryState?.latestAttempt || null
  };
}

async function enqueueDueGroupBuySettlementJobs(input = {}) {
  const now = input.now || new Date().toISOString();
  const dueInput = {
    now,
    limit: input.limit
  };
  const dueActivities = input.settlementRepository
    ? await input.settlementRepository.listDueActivities(dueInput)
    : listDueGroupBuyActivitiesForSettlement(dueInput);
  return Promise.all(dueActivities.map((activity) => {
    const jobInput = {
      jobType: "settle_group_buy_activity",
      resourceType: "activity",
      resourceId: activity.id,
      payload: {
        activityId: activity.id,
        actorUserId: input.actorUserId || null
      },
      maxAttempts: input.maxAttempts || 20,
      runAfter: now,
      now
    };
    return input.settlementRepository
      ? input.settlementRepository.enqueueJob(jobInput)
      : enqueuePaymentReliabilityJob(jobInput);
  }));
}

async function completeSettlementJob(input, jobInput) {
  return input.settlementRepository
    ? input.settlementRepository.completeJob(jobInput)
    : completePaymentReliabilityJob(jobInput);
}

async function rescheduleSettlementJob(input, jobInput) {
  return input.settlementRepository
    ? input.settlementRepository.rescheduleJob(jobInput)
    : reschedulePaymentReliabilityJob(jobInput);
}

async function runDueGroupBuySettlementJobs(input = {}) {
  const now = input.now || new Date().toISOString();
  const workerId = input.workerId || `settlement-worker-${process.pid}-${randomUUID()}`;
  const retryIntervalMs = normalizeSchedulerNumber(
    input.retryIntervalMs,
    null,
    CAPTURE_RETRY_INTERVAL_MS
  );
  const queued = await enqueueDueGroupBuySettlementJobs(input);
  const claimInput = {
    jobType: "settle_group_buy_activity",
    workerId,
    limit: input.limit || 20,
    leaseMs: input.leaseMs || 300_000,
    now
  };
  const jobs = input.settlementRepository
    ? await input.settlementRepository.claimJobs(claimInput)
    : claimPaymentReliabilityJobs(claimInput);
  const results = [];

  for (const job of jobs) {
    try {
      const result = await settleGroupBuyActivity({
        activityId: job.payload.activityId || job.resourceId,
        actorUserId: job.payload.actorUserId || input.actorUserId || null,
        lockOwnerId: `${workerId}:${job.id}`,
        leaseMs: input.leaseMs || 300_000,
        now,
        settlementRepository: input.settlementRepository,
        paymentCaptureRepository: input.paymentCaptureRepository,
        authorizationCancelRepository: input.authorizationCancelRepository,
        pushTokenRepository: input.pushTokenRepository,
        logger: input.logger
      });
      const retryable = !result
        || result.error === "settlement_retry_pending"
        || result.error === "settlement_locked"
        || (result.error && result.error !== "activity_already_settled" && result.error !== "settlement_not_due");
      const persisted = retryable
        ? await rescheduleSettlementJob(input, {
            jobId: job.id,
            workerId,
            runAfter: new Date(Date.parse(now) + retryIntervalMs).toISOString(),
            error: result || { error: "activity_not_found" },
            terminal: !result,
            now
          })
        : await completeSettlementJob(input, { jobId: job.id, workerId, now });
      results.push({ job: persisted, result });
    } catch (error) {
      const persisted = await rescheduleSettlementJob(input, {
        jobId: job.id,
        workerId,
        runAfter: new Date(Date.parse(now) + retryIntervalMs).toISOString(),
        error: error.payload || { message: error.message },
        now
      });
      results.push({ job: persisted, error: error.payload || { message: error.message } });
    }
  }

  return {
    checkedAt: now,
    queuedCount: queued.length,
    claimedCount: jobs.length,
    succeededCount: results.filter((entry) => entry.job?.status === "succeeded").length,
    retryPendingCount: results.filter((entry) => entry.job?.status === "retry_wait").length,
    failedCount: results.filter((entry) => entry.job?.status === "failed").length,
    results
  };
}

function startDeadlineSettlementScheduler(input = {}) {
  const env = input.env || process.env;
  const enabled = readBooleanEnv(env.SETTLEMENT_SCHEDULER_ENABLED, true);
  const linePayEnv = String(env.LINE_PAY_ENV || "sandbox").toLowerCase();
  const allowProduction = readBooleanEnv(env.SETTLEMENT_SCHEDULER_ALLOW_PRODUCTION, false);

  if (!enabled) {
    return createStoppedScheduler("disabled");
  }

  if (linePayEnv === "production" && !allowProduction) {
    return createStoppedScheduler("production_guard");
  }

  const intervalMs = normalizeSchedulerNumber(env.SETTLEMENT_SCHEDULER_INTERVAL_MS, input.intervalMs, 30_000);
  const limit = normalizeSchedulerNumber(env.SETTLEMENT_SCHEDULER_BATCH_SIZE, input.limit, 20);
  const actorUserId = env.SETTLEMENT_SCHEDULER_ACTOR_USER_ID || input.actorUserId || null;
  const logger = input.logger || console;
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running || stopped) {
      return null;
    }

    running = true;
    try {
      const summary = await runDueGroupBuySettlementJobs({
        actorUserId,
        limit,
        now: input.nowProvider ? input.nowProvider() : undefined,
        settlementRepository: input.settlementRepository,
        paymentCaptureRepository: input.paymentCaptureRepository,
        authorizationCancelRepository: input.authorizationCancelRepository,
        pushTokenRepository: input.pushTokenRepository,
        logger
      });

      if (summary.queuedCount > 0 || summary.failedCount > 0) {
        logger.info?.("[settlement-scheduler] run completed", {
          checkedAt: summary.checkedAt,
          queuedCount: summary.queuedCount,
          claimedCount: summary.claimedCount,
          succeededCount: summary.succeededCount,
          retryPendingCount: summary.retryPendingCount,
          failedCount: summary.failedCount
        });
      }

      for (const entry of summary.results || []) {
        if (!entry.job?.alertRequired) continue;
        logger.error?.("[payment-reliability-alert]", {
          source: "group_buy_settlement",
          jobId: entry.job.id,
          jobType: entry.job.jobType,
          resourceId: entry.job.resourceId,
          status: entry.job.status,
          attemptCount: entry.job.attemptCount,
          maxAttempts: entry.job.maxAttempts,
          lastError: entry.job.lastError
        });
        sendPaymentReliabilityJobAlert(entry, { source: "group_buy_settlement", logger });
      }
      return summary;
    } catch (error) {
      logger.error?.("[settlement-scheduler] run failed", {
        message: error.message,
        stack: error.stack
      });
      sendSchedulerFailureAlert(error, { source: "group_buy_settlement", logger });
      return {
        error: error.message
      };
    } finally {
      running = false;
    }
  }

  const interval = setInterval(runOnce, intervalMs);
  runOnce();

  return {
    enabled: true,
    reason: "enabled",
    intervalMs,
    limit,
    runOnce,
    stop() {
      stopped = true;
      clearInterval(interval);
    }
  };
}

function createStoppedScheduler(reason) {
  return {
    enabled: false,
    reason,
    runOnce: async () => null,
    stop() {}
  };
}

function normalizeSchedulerNumber(envValue, inputValue, fallback) {
  const numberValue = Number(envValue ?? inputValue ?? fallback);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return fallback;
  }
  return numberValue;
}

function readBooleanEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

module.exports = {
  enqueueDueGroupBuySettlementJobs,
  runDueGroupBuySettlementJobs,
  startDeadlineSettlementScheduler,
  settleGroupBuyActivity,
  buildGroupBuyQualifiedNotification,
  buildSettlementNotifications
};
