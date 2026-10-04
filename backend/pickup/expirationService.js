const {
  expireGroupBuyPickupWindow,
  listDueGroupBuyActivitiesForPickupExpiration
} = require("../db");
const { withOperationLeaseSync } = require("../reliability/operationLease");
const { notifyUsers } = require("../notifications/pushSender");

async function runDuePickupExpirations(input = {}) {
  const now = input.now || new Date().toISOString();
  const limit = normalizeSchedulerNumber(input.limit, 20);
  const actorUserId = input.actorUserId || null;
  const repository = input.pickupCredentialRepository;
  const dueActivities = repository?.kind === "postgres"
    ? await repository.listDueActivities({ now, limit })
    : listDueGroupBuyActivitiesForPickupExpiration({ now, limit });
  const results = [];
  const failures = [];

  for (const activity of dueActivities) {
    try {
      let result;
      if (repository?.kind === "postgres") {
        result = await repository.withOperationLock(
          { activityId: activity.id },
          () => repository.expireWindow({ activityId: activity.id, actorUserId, now })
        );
      } else {
        result = withOperationLeaseSync({
          lockKey: `pickup:activity:${activity.id}:transition`,
          leaseMs: 120_000
        }, () => expireGroupBuyPickupWindow(activity.id, { now, actorUserId }));
      }
      results.push({ activityId: activity.id, status: result.status, ...result });
    } catch (error) {
      failures.push({ activityId: activity.id, error: error.message });
    }
  }

  return {
    checkedAt: now,
    dueActivityCount: dueActivities.length,
    expiredActivityCount: results.filter((result) => result.status === "completed").length,
    skippedCount: results.filter((result) => result.status !== "completed").length,
    failedCount: failures.length,
    results,
    failures
  };
}

const DEFAULT_REMINDER_LEAD_MINUTES = 30;

// Pure and side-effect-free so the wording is unit-testable without a database or the Expo push
// call. `group` is one activity's claimed batch from claimPickupReminders.
function buildPickupReminderNotification(group) {
  const closesAt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(group.expiresAt));
  const where = group.storeName ? `你在 ${group.storeName} 的飲料` : "你的飲料";
  return {
    userIds: group.customerUserIds,
    title: "取餐時間快結束了",
    body: `${where}還沒領取，請在 ${closesAt} 前領取`,
    data: { type: "pickup_closing_soon", activityId: group.activityId }
  };
}

// Sends one reminder per ready-but-unclaimed order whose pickup window closes within `leadMinutes`.
// A no-op unless the repository is Postgres (needs orders.pickup_reminder_sent_at, migration 010)
// and push is wired. Never throws: a failed reminder must not take the expiration run down with it.
async function runDuePickupReminders(input = {}) {
  const repository = input.pickupCredentialRepository;
  const leadMinutes = input.leadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES;
  if (repository?.kind !== "postgres" || !input.pushTokenRepository || !(leadMinutes > 0)) {
    return { reminderGroupCount: 0, reminderOrderCount: 0 };
  }
  const logger = input.logger || console;
  try {
    const groups = await repository.claimPickupReminders({ now: input.now, leadMinutes });
    for (const group of groups) {
      await notifyUsers(buildPickupReminderNotification(group), {
        pushTokenRepository: input.pushTokenRepository,
        logger
      });
    }
    return {
      reminderGroupCount: groups.length,
      reminderOrderCount: groups.reduce((sum, group) => sum + group.orderIds.length, 0)
    };
  } catch (error) {
    logger.error?.("[pickup-reminder] run failed", { message: error.message });
    return { reminderGroupCount: 0, reminderOrderCount: 0, error: error.message };
  }
}

function readReminderLeadMinutes(value) {
  if (value == null || value === "") return DEFAULT_REMINDER_LEAD_MINUTES;
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_REMINDER_LEAD_MINUTES;
}

function startPickupExpirationScheduler(input = {}) {
  const env = input.env || process.env;
  const enabled = readBooleanEnv(env.PICKUP_EXPIRATION_SCHEDULER_ENABLED, true);
  if (!enabled) return createStoppedScheduler("disabled");

  const intervalMs = normalizeSchedulerNumber(
    env.PICKUP_EXPIRATION_SCHEDULER_INTERVAL_MS ?? input.intervalMs,
    30_000
  );
  const limit = normalizeSchedulerNumber(
    env.PICKUP_EXPIRATION_SCHEDULER_BATCH_SIZE ?? input.limit,
    20
  );
  const actorUserId = env.PICKUP_EXPIRATION_SCHEDULER_ACTOR_USER_ID || input.actorUserId || null;
  // PICKUP_REMINDER_LEAD_MINUTES=0 turns the "closing soon" push reminder off.
  const reminderLeadMinutes = readReminderLeadMinutes(env.PICKUP_REMINDER_LEAD_MINUTES ?? input.reminderLeadMinutes);
  const logger = input.logger || console;
  let running = false;
  let stopped = false;

  async function runOnce() {
    if (running || stopped) return null;
    running = true;
    try {
      const summary = await runDuePickupExpirations({
        actorUserId,
        limit,
        now: input.nowProvider ? input.nowProvider() : undefined,
        pickupCredentialRepository: input.pickupCredentialRepository
      });
      if (summary.dueActivityCount > 0 || summary.failedCount > 0) {
        logger.info?.("[pickup-expiration-scheduler] run completed", summary);
      }
      const reminders = await runDuePickupReminders({
        now: input.nowProvider ? input.nowProvider() : undefined,
        leadMinutes: reminderLeadMinutes,
        pickupCredentialRepository: input.pickupCredentialRepository,
        pushTokenRepository: input.pushTokenRepository,
        logger
      });
      if (reminders.reminderOrderCount > 0) {
        logger.info?.("[pickup-expiration-scheduler] pickup reminders sent", reminders);
      }
      return summary;
    } catch (error) {
      logger.error?.("[pickup-expiration-scheduler] run failed", {
        message: error.message,
        stack: error.stack
      });
      return { error: error.message };
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

function normalizeSchedulerNumber(value, fallback) {
  const numberValue = Number(value ?? fallback);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return fallback;
  return numberValue;
}

function readBooleanEnv(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

module.exports = {
  buildPickupReminderNotification,
  runDuePickupExpirations,
  runDuePickupReminders,
  startPickupExpirationScheduler
};
