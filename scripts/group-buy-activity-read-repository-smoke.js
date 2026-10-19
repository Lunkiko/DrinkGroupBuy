const assert = require("node:assert/strict");
const {
  createGroupBuyActivityReadRepository,
  resolveGroupBuyActivityReadRuntime,
} = require("../backend/database/repositories/groupBuyActivityReadRepository");

async function main() {
  await verifySqliteDelegation();
  await verifyPostgresContract();
  await verifyEmptyPostgresResult();
  verifyRuntimeValidation();
  console.log("Group-buy activity read repository smoke test passed.");
}

async function verifySqliteDelegation() {
  const expected = [{ id: "activity-sqlite" }];
  let callCount = 0;
  const repository = createGroupBuyActivityReadRepository({
    env: {},
    sqliteReader() {
      callCount += 1;
      return expected;
    },
  });

  assert.equal(repository.kind, "sqlite");
  assert.equal(await repository.listActivities(), expected);
  assert.equal(callCount, 1);
  await repository.close();
}

async function verifyPostgresContract() {
  const calls = [];
  const database = {
    kind: "postgres",
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("FROM group_buy_activities")) {
        return { rows: [{
          id: "activity-pg-001",
          store_id: "store-001",
          created_by_user_id: "user-merchant-001",
          title: "PostgreSQL 團購",
          status: "recruiting",
          start_at: new Date("2026-07-30T01:00:00.000Z"),
          deadline_at: new Date("2026-07-30T02:00:00.000Z"),
          pickup_start_at: new Date("2026-07-30T02:30:00.000Z"),
          pickup_end_at: new Date("2026-07-30T05:30:00.000Z"),
          maximum_cups: 40,
          withdrawal_lock_minutes: 30,
          cancellation_reason: null,
          store_name: "青山手作茶 中科店",
          store_address: "台中市北區三民路三段 150 號",
          latitude: 24.1511,
          store_phone: "04-2233-0001",
          longitude: 120.6817,
        }] };
      }
      if (sql.includes("FROM promotion_tiers")) {
        return { rows: [
          {
            id: "tier-pg-20",
            activity_id: "activity-pg-001",
            target_cups: 20,
            discount_percent: 10,
            sort_order: 0,
          },
          {
            id: "tier-pg-40",
            activity_id: "activity-pg-001",
            target_cups: 40,
            discount_percent: 30,
            sort_order: 1,
          },
        ] };
      }
      if (sql.includes("FROM orders")) {
        return { rows: [{
          activity_id: "activity-pg-001",
          authorized_cups: "20",
          participant_count: "2",
        }] };
      }
      if (sql.includes("FROM activity_settlements")) {
        return { rows: [{
          id: "settlement-pg-001",
          activity_id: "activity-pg-001",
          outcome: "qualified",
          authorized_cups: "20",
          applied_tier_id: "tier-pg-20",
          total_discount_amount: "40",
          discount_percent: "10",
          discount_funder: "merchant",
          calculation_version: "percentage_v1",
          settled_at: new Date("2026-07-30T02:00:05.000Z"),
          reason: "deadline_settlement_completed",
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  const repository = createGroupBuyActivityReadRepository({ runtime: "postgres", database });

  assert.equal(repository.kind, "postgres");
  assert.deepEqual(await repository.listActivities(), [{
    id: "activity-pg-001",
    storeId: "store-001",
    title: "PostgreSQL 團購",
    status: "confirmed",
    rawStatus: "recruiting",
    startAt: "2026-07-30T01:00:00.000Z",
    deadlineAt: "2026-07-30T02:00:00.000Z",
    pickupStartAt: "2026-07-30T02:30:00.000Z",
    pickupEndAt: "2026-07-30T05:30:00.000Z",
    maximumCups: 40,
    targetCups: 20,
    currentCups: 20,
    authorizedCups: 20,
    participantCount: 2,
    currentTierId: "tier-pg-20",
    currentTierTargetCups: 20,
    currentTierDiscountPercent: 10,
    nextTierTargetCups: 40,
    cupsToNextTier: 20,
    settlement: {
      id: "settlement-pg-001",
      activityId: "activity-pg-001",
      outcome: "qualified",
      authorizedCups: 20,
      appliedTierId: "tier-pg-20",
      totalDiscountAmount: 40,
      discountPercent: 10,
      discountFunder: "merchant",
      calculationVersion: "percentage_v1",
      settledAt: "2026-07-30T02:00:05.000Z",
      reason: "deadline_settlement_completed",
    },
    withdrawalLockMinutes: 30,
    cancellationReason: null,
    store: {
      name: "青山手作茶 中科店",
      address: "台中市北區三民路三段 150 號",
      latitude: 24.1511,
      phone: "04-2233-0001",
      longitude: 120.6817,
    },
    tiers: [
      { id: "tier-pg-20", targetCups: 20, cups: 20, discountPercent: 10, sortOrder: 0 },
      { id: "tier-pg-40", targetCups: 40, cups: 40, discountPercent: 30, sortOrder: 1 },
    ],
  }]);
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.parameters.length === 0));
  assert.match(calls.find((call) => call.sql.includes("FROM orders")).sql, /payment_status IN/);
  await repository.close();
}

async function verifyEmptyPostgresResult() {
  const repository = createGroupBuyActivityReadRepository({
    runtime: "postgresql",
    database: { query: async () => ({ rows: [] }) },
  });
  assert.deepEqual(await repository.listActivities(), []);
}

function verifyRuntimeValidation() {
  assert.equal(resolveGroupBuyActivityReadRuntime({ env: {} }), "sqlite");
  assert.equal(
    resolveGroupBuyActivityReadRuntime({
      env: { GROUP_BUY_ACTIVITY_READ_RUNTIME: "POSTGRESQL" },
    }),
    "postgres"
  );
  assert.throws(
    () => resolveGroupBuyActivityReadRuntime({ runtime: "mysql" }),
    /Unsupported GROUP_BUY_ACTIVITY_READ_RUNTIME/
  );
  assert.throws(
    () => createGroupBuyActivityReadRepository({
      env: { GROUP_BUY_ACTIVITY_READ_RUNTIME: "postgres" },
    }),
    /DATABASE_URL is required/
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
