const { createRuntimeDatabaseAdapter } = require("..");
const { resolveAppliedDiscountTier } = require("../../pricing/groupBuyDiscount");

function resolveGroupBuyActivityReadRuntime(input = {}) {
  const env = input.env || process.env;
  const runtime = String(input.runtime || env.GROUP_BUY_ACTIVITY_READ_RUNTIME || "sqlite")
    .trim()
    .toLowerCase();
  if (runtime === "sqlite") return "sqlite";
  if (runtime === "postgres" || runtime === "postgresql") return "postgres";
  throw new Error(`Unsupported GROUP_BUY_ACTIVITY_READ_RUNTIME: ${runtime}`);
}

function createGroupBuyActivityReadRepository(input = {}) {
  const runtime = resolveGroupBuyActivityReadRuntime(input);
  if (runtime === "sqlite") {
    if (typeof input.sqliteReader !== "function") {
      throw new Error("sqliteReader is required when GROUP_BUY_ACTIVITY_READ_RUNTIME=sqlite");
    }
    return {
      kind: "sqlite",
      listActivities: async () => input.sqliteReader(),
      close: async () => {},
    };
  }

  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({
    ...input,
    runtime: "postgres",
  });
  return {
    kind: "postgres",
    listActivities: () => listPostgresGroupBuyActivities(database),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

async function listPostgresGroupBuyActivities(database) {
  const [activitiesResult, tiersResult, progressResult, settlementsResult] = await Promise.all([
    database.query(`
      SELECT
        activity.id,
        activity.store_id,
        activity.title,
        activity.status,
        activity.start_at,
        activity.deadline_at,
        activity.pickup_start_at,
        activity.pickup_end_at,
        activity.maximum_cups,
        activity.withdrawal_lock_minutes,
        activity.cancellation_reason,
        store.name AS store_name,
        store.address AS store_address,
        store.phone AS store_phone,
        store.latitude,
        store.longitude
      FROM group_buy_activities activity
      JOIN stores store ON store.id = activity.store_id
      ORDER BY activity.created_at DESC
    `),
    database.query(`
      SELECT id, activity_id, target_cups, discount_percent, sort_order
      FROM promotion_tiers
      ORDER BY target_cups ASC
    `),
    database.query(`
      SELECT
        activity_id,
        COALESCE(SUM(total_cups), 0) AS authorized_cups,
        COUNT(*) AS participant_count
      FROM orders
      WHERE payment_status IN ('authorized', 'captured')
        AND status NOT IN ('cancelled')
      GROUP BY activity_id
    `),
    database.query(`
      SELECT
        id,
        activity_id,
        outcome,
        authorized_cups,
        applied_tier_id,
        total_discount_amount,
        discount_percent,
        discount_funder,
        calculation_version,
        settled_at,
        reason
      FROM activity_settlements
    `),
  ]);

  const progressByActivityId = new Map(
    progressResult.rows.map((row) => [row.activity_id, row])
  );
  const settlementByActivityId = new Map(
    settlementsResult.rows.map((row) => [row.activity_id, mapActivitySettlement(row)])
  );

  return activitiesResult.rows.map((row) => {
    const activityTiers = tiersResult.rows
      .filter((tier) => tier.activity_id === row.id)
      .map((tier) => ({
        id: tier.id,
        targetCups: tier.target_cups,
        cups: tier.target_cups,
        discountPercent: tier.discount_percent,
        sortOrder: tier.sort_order,
      }));
    const progress = progressByActivityId.get(row.id);
    const authorizedCups = Number(progress?.authorized_cups ?? 0);
    const participantCount = Number(progress?.participant_count ?? 0);
    const discountSummary = resolveAppliedDiscountTier(activityTiers, authorizedCups);
    const firstTargetCups = activityTiers[0]?.targetCups ?? row.maximum_cups ?? 0;
    const displayStatus = row.status === "recruiting" && authorizedCups >= firstTargetCups
      ? "confirmed"
      : row.status;

    return {
      id: row.id,
      storeId: row.store_id,
      title: row.title,
      status: displayStatus,
      rawStatus: row.status,
      startAt: toIsoString(row.start_at),
      deadlineAt: toIsoString(row.deadline_at),
      pickupStartAt: toIsoString(row.pickup_start_at),
      pickupEndAt: toIsoString(row.pickup_end_at),
      maximumCups: row.maximum_cups,
      targetCups: firstTargetCups,
      currentCups: authorizedCups,
      authorizedCups,
      participantCount,
      ...discountSummary,
      settlement: settlementByActivityId.get(row.id) ?? null,
      withdrawalLockMinutes: row.withdrawal_lock_minutes,
      cancellationReason: row.cancellation_reason,
      store: {
        name: row.store_name,
        address: row.store_address,
        phone: row.store_phone,
        latitude: row.latitude,
        longitude: row.longitude,
      },
      tiers: activityTiers,
    };
  });
}

function mapActivitySettlement(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    outcome: row.outcome,
    authorizedCups: Number(row.authorized_cups),
    appliedTierId: row.applied_tier_id,
    totalDiscountAmount: Number(row.total_discount_amount),
    discountPercent: row.discount_percent == null ? null : Number(row.discount_percent),
    discountFunder: row.discount_funder,
    calculationVersion: row.calculation_version,
    settledAt: toIsoString(row.settled_at),
    reason: row.reason,
  };
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value;
}

module.exports = {
  createGroupBuyActivityReadRepository,
  listPostgresGroupBuyActivities,
  resolveGroupBuyActivityReadRuntime,
};
