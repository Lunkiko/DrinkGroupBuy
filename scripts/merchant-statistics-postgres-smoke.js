"use strict";

// Proves, against real PostgreSQL, exactly which orders feed a store's statistics and that one store
// can never see another store's figures. It builds THREE brand-new temporary stores (closed, so no
// app screen lists them) so every expected number is exact with no dependence on existing local
// data: a store with sales, a second store whose (much larger) sales must not leak in, and an
// empty store. Only rows created here (unique ids) are inserted, and all of them are deleted again.

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const {
  createMerchantStatisticsRepository,
} = require("../backend/database/repositories/merchantStatisticsRepository");

const proofId = randomUUID();
const merchantId = `merchant-stats-proof-${proofId}`;
const storeId = (name) => `store-stats-proof-${name}-${proofId}`;
const STORES = { target: storeId("target"), other: storeId("other"), empty: storeId("empty") };

// Every fixture order below shares the same submitted_at (iso(-90), see insertOrders), so they all
// land in one calendar week -- this is that week's Monday in Asia/Taipei time, matching what
// getStoreWeeklyTrend buckets by (date_trunc('week', ... AT TIME ZONE 'Asia/Taipei')). Built from
// Date.UTC/getUTCDay only, independent of this machine's own local timezone.
function currentTaipeiWeekStart() {
  const taipeiNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const dateOnly = new Date(Date.UTC(taipeiNow.getUTCFullYear(), taipeiNow.getUTCMonth(), taipeiNow.getUTCDate()));
  const isoDayOfWeek = dateOnly.getUTCDay() === 0 ? 7 : dateOnly.getUTCDay(); // 1=Mon .. 7=Sun
  dateOnly.setUTCDate(dateOnly.getUTCDate() - (isoDayOfWeek - 1));
  return dateOnly.toISOString().slice(0, 10);
}
const targetWeekStart = currentTaipeiWeekStart();

// getStoreWeeklyTrend now zero-fills every week in its window (see its own comment), so the expected
// array for every store below is this same 9-week series with only the target week's numbers
// differing per store -- not just a single-row or empty array like before that fill-in existed.
const WEEKLY_TREND_WEEKS = 9;
function weekSeriesEndingAt(weekStartString, count) {
  const [year, month, day] = weekStartString.split("-").map(Number);
  const base = new Date(Date.UTC(year, month - 1, day));
  const series = [];
  for (let weeksAgo = count - 1; weeksAgo >= 0; weeksAgo--) {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() - weeksAgo * 7);
    series.push(date.toISOString().slice(0, 10));
  }
  return series;
}
const expectedWeekSeries = weekSeriesEndingAt(targetWeekStart, WEEKLY_TREND_WEEKS);
function buildExpectedWeeklyTrend(targetWeekFigures) {
  return expectedWeekSeries.map((weekStart) => (
    weekStart === targetWeekStart
      ? { weekStart, ...targetWeekFigures }
      : { weekStart, orderCount: 0, revenue: 0, discountAmount: 0 }
  ));
}

// One activity per order (unique index: one non-cancelled order per activity and customer).
// items: [name, quantity, unit price]. `refunds` are merchant_refund_marks rows recorded against
// the order (scheme B self-reported refund, 2026-10-21) -- [status, amount] pairs, status is
// 'active' (counts against revenue) or 'revoked' (must not).
const orders = [
  // ---- These four are the store's sales.
  { key: "sold-discounted", store: "target", activityStatus: "completed", settlement: "qualified", status: "completed", payment: "captured", pickup: "picked_up", cups: 3, original: 195, final: 137, items: [["烏龍拿鐵", 3, 65]] },
  { key: "sold-unclaimed", store: "target", activityStatus: "completed", settlement: "qualified", status: "completed", payment: "captured", pickup: "expired", cups: 2, original: 130, final: 104, items: [["烏龍拿鐵", 2, 65]] },
  { key: "sold-full-price", store: "target", activityStatus: "completed", settlement: "failed", status: "completed", payment: "captured", pickup: "picked_up", cups: 3, original: 60, final: 60, items: [["紅茶", 1, 30], ["奶茶", 2, 15]] },
  { key: "sold-part-refunded", store: "target", activityStatus: "completed", settlement: null, status: "completed", payment: "captured", pickup: "picked_up", cups: 3, original: 100, final: 80, items: [["紅茶", 2, 30], ["綠茶", 1, 40]], refunds: [["active", 30]] },
  // Two active marks add up (10 + 5); a revoked mark must NOT be subtracted.
  { key: "sold-many-refunds", store: "target", activityStatus: "completed", settlement: null, status: "completed", payment: "captured", pickup: "picked_up", cups: 1, original: 50, final: 40, items: [["冬瓜茶", 1, 50]], refunds: [["active", 10], ["active", 5], ["revoked", 20]] },
  // ---- None of these may count.
  { key: "fully-refunded", store: "target", activityStatus: "completed", settlement: null, status: "completed", payment: "refunded", pickup: "picked_up", cups: 99, original: 9900, final: 9000, items: [["不該出現-全額退款", 99, 100]] },
  { key: "activity-cancelled", store: "target", activityStatus: "cancelled", settlement: "qualified", status: "locked", payment: "captured", pickup: "not_ready", cups: 99, original: 9900, final: 9000, items: [["不該出現-團購取消", 99, 100]] },
  { key: "order-cancelled", store: "target", activityStatus: "completed", settlement: null, status: "cancelled", payment: "captured", pickup: "cancelled", cups: 99, original: 9900, final: 9000, items: [["不該出現-訂單取消", 99, 100]] },
  { key: "authorized-only", store: "target", activityStatus: "ordering", settlement: null, status: "locked", payment: "authorized", pickup: "not_ready", cups: 99, original: 9900, final: null, items: [["不該出現-未請款", 99, 100]] },
  { key: "voided", store: "target", activityStatus: "failed", settlement: null, status: "cancelled", payment: "authorization_voided", pickup: "cancelled", cups: 99, original: 9900, final: null, items: [["不該出現-已作廢", 99, 100]] },
  // ---- Another store: bigger numbers that must never show up in the target store's figures.
  { key: "other-store-sale", store: "other", activityStatus: "completed", settlement: "qualified", status: "completed", payment: "captured", pickup: "picked_up", cups: 50, original: 3000, final: 2500, items: [["烏龍拿鐵", 50, 60]] },
].map((fixture) => ({
  ...fixture,
  orderId: `order-stats-proof-${fixture.key}-${proofId}`,
  activityId: `activity-stats-proof-${fixture.key}-${proofId}`,
}));

// target store: revenue (137+104+60+80+40) - refunds (30 + 10 + 5) = 376; discount 58+26+0+20+10 = 114; 5 orders.
// settled activities: two qualified + one failed -> 2/3 (the settled-then-cancelled activity is left out).
// Top drinks: 烏龍拿鐵 5, 紅茶 3, 奶茶 2 (綠茶 1 and 冬瓜茶 1 are behind).
const expectedTarget = {
  totalRevenue: 376,
  orderCount: 5,
  discountGivenTotal: 114,
  settledActivityCount: 3,
  qualifiedActivityCount: 2,
  qualifiedRate: 2 / 3,
  topDrinks: [{ name: "烏龍拿鐵", cups: 5 }, { name: "紅茶", cups: 3 }, { name: "奶茶", cups: 2 }],
};
const expectedOther = {
  totalRevenue: 2500,
  orderCount: 1,
  discountGivenTotal: 500,
  settledActivityCount: 1,
  qualifiedActivityCount: 1,
  qualifiedRate: 1,
  topDrinks: [{ name: "烏龍拿鐵", cups: 50 }],
};
const expectedEmpty = {
  totalRevenue: 0, orderCount: 0, discountGivenTotal: 0,
  settledActivityCount: 0, qualifiedActivityCount: 0, qualifiedRate: null, topDrinks: [],
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL merchant statistics smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createMerchantStatisticsRepository({ database });
  try {
    await createFixture(database);
    assert.deepEqual(await repository.getStoreStatistics(STORES.target), expectedTarget);
    assert.deepEqual(await repository.getStoreStatistics(STORES.other), expectedOther);
    assert.deepEqual(await repository.getStoreStatistics(STORES.empty), expectedEmpty);
    assert.deepEqual(
      await repository.getStoreStatistics(`store-that-does-not-exist-${proofId}`),
      expectedEmpty,
    );

    // Weekly trend is not refund-adjusted (see getStoreWeeklyTrendPostgres's own comment), so target's
    // revenue here (421) differs from expectedTarget.totalRevenue (376, which subtracts the 45 in
    // refunds); the order count and discount total are the same set of orders either way.
    assert.deepEqual(
      await repository.getStoreWeeklyTrend(STORES.target),
      buildExpectedWeeklyTrend({ orderCount: 5, revenue: 421, discountAmount: 114 }),
    );
    assert.deepEqual(
      await repository.getStoreWeeklyTrend(STORES.other),
      buildExpectedWeeklyTrend({ orderCount: 1, revenue: 2500, discountAmount: 500 }),
    );
    assert.deepEqual(
      await repository.getStoreWeeklyTrend(STORES.empty),
      buildExpectedWeeklyTrend({ orderCount: 0, revenue: 0, discountAmount: 0 }),
    );

    console.log("PostgreSQL merchant statistics proof passed.");
  } finally {
    await cleanup(database);
    await database.close();
  }
}

async function createFixture(database) {
  const [customers, creator] = await Promise.all([
    database.query(`
      SELECT user_account.id
      FROM users user_account
      JOIN user_roles user_role ON user_role.user_id = user_account.id
      WHERE user_role.role = 'customer' AND user_role.status = 'active' AND user_account.status = 'active'
      ORDER BY user_account.id
      LIMIT 1
    `),
    database.query("SELECT user_id FROM merchant_users WHERE status = 'active' LIMIT 1"),
  ]);
  assert.ok(customers.rows[0]?.id, "An active PostgreSQL customer is required");
  assert.ok(creator.rows[0]?.user_id, "An active merchant user is required");
  const customerId = customers.rows[0].id;
  const creatorId = creator.rows[0].user_id;
  const now = new Date();
  const iso = (offsetMinutes) => new Date(now.getTime() + offsetMinutes * 60_000).toISOString();

  await database.transaction(async (transaction) => {
    await transaction.query(
      "INSERT INTO merchants (id, name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)",
      [merchantId, `Stats proof merchant ${proofId}`, iso(0)],
    );
    for (const [name, id] of Object.entries(STORES)) {
      // 'closed' keeps these stores off every app screen for the few seconds they exist.
      await transaction.query(`
        INSERT INTO stores (id, merchant_id, name, address, phone, business_status, latitude, longitude, created_at, updated_at)
        VALUES ($1, $2, $3, 'test address', NULL, 'closed', 24.0, 120.0, $4, $4)
      `, [id, merchantId, `Stats proof store ${name}`, iso(0)]);
    }
    await insertOrders(transaction, { customerId, creatorId, iso });
  });
}

async function insertOrders(transaction, { customerId, creatorId, iso }) {
  for (const fixture of orders) {
    // Deadlines stay in the future so a running backend's deadline-settlement scheduler never
    // touches these fake activities mid-run (its settlement rows would also block the cleanup).
    await transaction.query(`
      INSERT INTO group_buy_activities (
        id, store_id, created_by_user_id, title, status,
        start_at, deadline_at, pickup_start_at, pickup_end_at,
        maximum_cups, withdrawal_lock_minutes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 100, 30, $6, $6)
    `, [fixture.activityId, STORES[fixture.store], creatorId, `Stats proof ${fixture.key}`,
      fixture.activityStatus, iso(-120), iso(30), iso(60), iso(120)]);
    await transaction.query(`
      INSERT INTO orders (
        id, activity_id, customer_user_id, status, fallback_purchase_preference,
        total_cups, original_amount, final_amount, payment_status,
        authorization_status, merchant_acceptance_status, pickup_status,
        submitted_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'decline_original_price', $5, $6, $7, $8,
                'authorized', 'accepted', $9, $10, $10)
    `, [fixture.orderId, fixture.activityId, customerId, fixture.status, fixture.cups,
      fixture.original, fixture.final, fixture.payment, fixture.pickup, iso(-90)]);
    for (const [index, [name, quantity, price]] of fixture.items.entries()) {
      await transaction.query(`
        INSERT INTO order_items (id, order_id, menu_item_id, item_name_snapshot, quantity, unit_price_snapshot, subtotal)
        VALUES ($1, $2, NULL, $3, $4, $5, $6)
      `, [`order-item-stats-proof-${fixture.key}-${index}-${proofId}`, fixture.orderId, name, quantity, price, quantity * price]);
    }
    if (fixture.settlement) {
      await transaction.query(`
        INSERT INTO activity_settlements (
          id, activity_id, outcome, authorized_cups, applied_tier_id, total_discount_amount,
          settled_at, reason, discount_funder, calculation_version, discount_percent
        ) VALUES ($1, $2, $3, $4, NULL, $5, $6, 'deadline_settlement_completed', 'merchant', 'percentage_v1', NULL)
      `, [`settlement-stats-proof-${fixture.key}-${proofId}`, fixture.activityId, fixture.settlement,
        fixture.cups, fixture.original - fixture.final, iso(-30)]);
    }
    if (fixture.refunds) await insertRefundMarks(transaction, fixture, creatorId, iso);
  }
}

async function insertRefundMarks(transaction, fixture, creatorId, iso) {
  for (const [index, [status, amount]] of fixture.refunds.entries()) {
    const revoked = status === "revoked";
    await transaction.query(`
      INSERT INTO merchant_refund_marks (
        id, order_id, store_id, marked_by_user_id, amount, reason, status,
        idempotency_key, revoked_at, revoked_by_user_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, 'stats proof', $6, $7, $8, $9, $10, $10)
    `, [`refund-mark-stats-proof-${fixture.key}-${index}-${proofId}`, fixture.orderId, STORES[fixture.store],
      creatorId, amount, status, `refund-mark-key-stats-proof-${fixture.key}-${index}-${proofId}`,
      revoked ? iso(-5) : null, revoked ? creatorId : null, iso(-10)]);
  }
}

async function cleanup(database) {
  const orderIds = orders.map((fixture) => fixture.orderId);
  const activityIds = orders.map((fixture) => fixture.activityId);
  const storeIds = Object.values(STORES);
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM merchant_refund_marks WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM activity_settlements WHERE activity_id = ANY($1::text[])", [activityIds]);
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
    await transaction.query("DELETE FROM stores WHERE id = ANY($1::text[])", [storeIds]);
    await transaction.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($1::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($2::text[])) AS activity_count,
      (SELECT COUNT(*)::integer FROM stores WHERE id = ANY($3::text[])) AS store_count,
      (SELECT COUNT(*)::integer FROM merchants WHERE id = $4) AS merchant_count
  `, [orderIds, activityIds, storeIds, merchantId]);
  assert.deepEqual(residue.rows[0], { order_count: 0, activity_count: 0, store_count: 0, merchant_count: 0 });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
