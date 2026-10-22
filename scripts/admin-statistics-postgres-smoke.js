"use strict";

// Proves, against real PostgreSQL, that the admin weekly-trend, peak-hours, customer-retention and
// basic-statistics queries bucket/net correctly. These aggregate the WHOLE orders/customers set
// (there is no per-store id to scope a fixture to, unlike the merchant/customer statistics
// repositories), so this can't assert exact totals against a shared dev database -- instead it
// reads each function before and after inserting known fixture rows, and asserts the DELTA.
//
// The basic-statistics revenue delta below only exercises the merchant_refund_marks join (not
// payment_refunds): that second join is the identical shape merchantStatisticsRepository.js's own
// smoke test already proves against real payment_refunds rows (which need a full payment_captures/
// payment_authorizations chain to fixture), so re-proving the same join shape here would duplicate
// coverage without testing anything new -- see docs/AI-security-review-log.md 2026-10-22.

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const { createAdminStatisticsRepository } = require("../backend/database/repositories/adminStatisticsRepository");

const proofId = randomUUID();
const merchantId = `merchant-admin-stats-proof-${proofId}`;
const storeId = `store-admin-stats-proof-${proofId}`;

// Today's date as Taipei sees it, computed without ever letting a Date value pass through this
// machine's own local timezone (shift by +8h, then read UTC getters -- same trick the fixture
// timestamps below use, and the same reasoning behind AT TIME ZONE 'Asia/Taipei' in the repository).
function taipeiTodayDateString() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return formatUtcDateOnly(shifted);
}

// Shared by every "YYYY-MM-DD" date-only helper below, so each one only has to state its own day
// offset instead of re-deriving the parse/format boilerplate. Built entirely from Date.UTC/getUTC*
// so it's independent of this machine's local timezone.
function parseUtcDateOnly(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}
function formatUtcDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

// The Monday (ISO week start) that a given "YYYY-MM-DD" calendar date falls in, matching Postgres's
// date_trunc('week', ...).
function isoWeekStart(dateString) {
  const date = parseUtcDateOnly(dateString);
  const isoDayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // 1=Mon .. 7=Sun
  date.setUTCDate(date.getUTCDate() - (isoDayOfWeek - 1));
  return formatUtcDateOnly(date);
}

function taipeiInstant(dateString, hour, minute) {
  return `${dateString}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`;
}

// N weeks before a "YYYY-MM-DD" calendar date.
function taipeiDateWeeksAgo(dateString, weeks) {
  const date = parseUtcDateOnly(dateString);
  date.setUTCDate(date.getUTCDate() - weeks * 7);
  return formatUtcDateOnly(date);
}

const todayTaipei = taipeiTodayDateString();
const targetWeekStart = isoWeekStart(todayTaipei);

// order-a: captured, lands in hour 9. order-b: authorized only (never captured), same hour 9, must
// NOT count toward weekly revenue/orderCount but MUST count toward the peak-hour total. order-c:
// cancelled, a different hour (22), must still count toward peak hours (see getPeakHoursPostgres's
// own reasoning) but not toward revenue.
const orders = [
  { key: "captured", activitySuffix: "a", status: "completed", payment: "captured", pickup: "picked_up", cups: 2, original: 100, final: 70, hour: 9, minute: 15 },
  { key: "authorized-only", activitySuffix: "b", status: "locked", payment: "authorized", pickup: "not_ready", cups: 1, original: 50, final: null, hour: 9, minute: 45 },
  { key: "cancelled", activitySuffix: "c", status: "cancelled", payment: "pending", pickup: "cancelled", cups: 1, original: 40, final: null, hour: 22, minute: 30 },
].map((fixture) => ({
  ...fixture,
  orderId: `order-admin-stats-proof-${fixture.key}-${proofId}`,
  activityId: `activity-admin-stats-proof-${fixture.activitySuffix}-${proofId}`,
  submittedAt: taipeiInstant(todayTaipei, fixture.hour, fixture.minute),
}));

// Three brand-new temporary customers (their whole order history is exactly what's created here):
// "new" orders once, this week only -> must not count as returning this week.
// "returning-recent" ordered 3 weeks ago (inside the 8-week trend window) and again this week.
// "returning-old" ordered 20 weeks ago (OUTSIDE the window) and again this week -- this is the case
// that would silently break if first_week were computed only from the windowed rows instead of the
// customer's full order history (see getCustomerRetentionPostgres's own comment on this).
// Both returning customers must still count as returning this week; only "new" must not.
const retentionCustomers = ["new", "returning-recent", "returning-old"].map((key) => ({
  key,
  userId: `user-admin-stats-proof-${key}-${proofId}`,
}));
const retentionOrders = [
  { key: "retention-new-current", customerKey: "new", activitySuffix: "rn", weeksAgo: 0, hour: 10, minute: 0 },
  { key: "retention-returning-recent-past", customerKey: "returning-recent", activitySuffix: "rrp", weeksAgo: 3, hour: 10, minute: 0 },
  { key: "retention-returning-recent-current", customerKey: "returning-recent", activitySuffix: "rrc", weeksAgo: 0, hour: 11, minute: 0 },
  { key: "retention-returning-old-past", customerKey: "returning-old", activitySuffix: "rop", weeksAgo: 20, hour: 10, minute: 0 },
  { key: "retention-returning-old-current", customerKey: "returning-old", activitySuffix: "roc", weeksAgo: 0, hour: 12, minute: 0 },
].map((fixture) => ({
  ...fixture,
  orderId: `order-admin-stats-proof-${fixture.key}-${proofId}`,
  activityId: `activity-admin-stats-proof-${fixture.activitySuffix}-${proofId}`,
  submittedAt: taipeiInstant(taipeiDateWeeksAgo(todayTaipei, fixture.weeksAgo), fixture.hour, fixture.minute),
}));

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL admin statistics smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createAdminStatisticsRepository({ database });
  try {
    const before = await readRelevantBuckets(repository);
    const sharedCustomer = await getSharedCustomerPriorState(database);
    await createFixture(database);
    const after = await readRelevantBuckets(repository);

    // Every captured order this fixture creates adds to the platform-wide revenue delta: orders[0]
    // ("captured", final_amount 70) plus the 5 retentionOrders (final_amount 50 each, all 'captured')
    // = 320 gross. orders[0] also gets a $20 active merchant_refund_mark, so the net delta must be
    // 320 - 20 = 300, not the gross 320.
    assert.equal(
      after.totalRevenue - before.totalRevenue, 300,
      "total revenue must net out the active merchant_refund_marks row against the captured order",
    );

    // The week bucket also picks up the 3 retention fixture orders submitted "this week" (see
    // retentionOrders below) -- each captured, original=final=50 (no discount): +3 orders, +150
    // revenue, +0 discount on top of the peak-hours fixture's own captured order.
    assert.deepEqual(
      { orderCount: after.week.orderCount - before.week.orderCount, revenue: after.week.revenue - before.week.revenue, discountAmount: after.week.discountAmount - before.week.discountAmount },
      { orderCount: 4, revenue: 220, discountAmount: 30 },
      "only captured orders should move the week bucket, by their own original-minus-final discount",
    );
    assert.equal(after.hour9 - before.hour9, 2, "both hour-9 orders should count toward peak hours regardless of payment status");
    assert.equal(after.hour22 - before.hour22, 1, "the cancelled hour-22 order should still count toward peak hours");

    // createFixture also submits one more order this week for the pre-existing shared customer (the
    // "captured" fixture near the top of this file, reused from the peak-hours/weekly-trend proof).
    // Every delta below adds that customer's own exact, precomputed contribution (see
    // getSharedCustomerPriorState's comment) on top of the 3 brand-new retention customers, instead
    // of assuming a fixed number that could be thrown off by whatever real history that shared
    // customer happens to have in this database.
    assert.equal(
      after.retention.totalCustomers - before.retention.totalCustomers,
      3 + (sharedCustomer.priorOrderCount === 0 ? 1 : 0),
      "the 3 brand-new retention customers, plus the shared customer only if this is their first-ever order",
    );
    assert.equal(
      after.retention.repeatCustomers - before.retention.repeatCustomers,
      2 + (sharedCustomer.priorOrderCount === 1 ? 1 : 0),
      "the 2 retention customers with 2+ orders, plus the shared customer only if this order is their 2nd ever",
    );
    assert.equal(
      after.retention.week.activeCustomerCount - before.retention.week.activeCustomerCount,
      3 + (sharedCustomer.alreadyActiveThisWeek ? 0 : 1),
      "the 3 retention customers, plus the shared customer only if they weren't already active this week",
    );
    assert.equal(
      after.retention.week.returningCustomerCount - before.retention.week.returningCustomerCount,
      // Mirrors the activeCustomerCount branch above: the shared customer only adds to this week's
      // returning count if this fixture is what makes them active THIS week in the first place
      // (alreadyActiveThisWeek false). If they already had an order this week before the fixture ran,
      // they were already counted in the "before" snapshot (being both returning and active that
      // week), so this fixture's extra order for them contributes 0, not 1 -- alreadyReturning alone
      // doesn't decide it.
      2 + (sharedCustomer.alreadyReturning && !sharedCustomer.alreadyActiveThisWeek ? 1 : 0),
      "the recent-returning and old-returning customers must count as returning this week -- " +
      "the old-returning case in particular proves first_week looked past the 8-week trend window",
    );

    console.log(`PostgreSQL admin statistics proof passed (week ${targetWeekStart}, hours 9 & 22).`);
  } finally {
    await cleanup(database);
    await database.close();
  }
}

async function readRelevantBuckets(repository) {
  const [weeklyTrend, peakHours, retention, basicStatistics] = await Promise.all([
    repository.getWeeklyTrend(), repository.getPeakHours(), repository.getCustomerRetention(),
    repository.getBasicStatistics(),
  ]);
  const week = weeklyTrend.find((row) => row.weekStart === targetWeekStart) ?? { orderCount: 0, revenue: 0, discountAmount: 0 };
  const retentionWeek = retention.weeklyReturning.find((row) => row.weekStart === targetWeekStart)
    ?? { activeCustomerCount: 0, returningCustomerCount: 0 };
  return {
    week,
    hour9: peakHours[9].orderCount,
    hour22: peakHours[22].orderCount,
    retention: {
      totalCustomers: retention.totalCustomers,
      repeatCustomers: retention.repeatCustomers,
      week: retentionWeek,
    },
    totalRevenue: basicStatistics.orders.totalRevenue,
  };
}

// The same deterministic "pick one active customer" query createFixture uses for its own
// customerId, reused by wasSharedCustomerAlreadyReturning so both refer to the exact same customer.
async function selectSharedCustomerId(database) {
  const result = await database.query(`
    SELECT user_account.id
    FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'customer' AND user_role.status = 'active' AND user_account.status = 'active'
    ORDER BY user_account.id
    LIMIT 1
  `);
  assert.ok(result.rows[0]?.id, "An active PostgreSQL customer is required");
  return result.rows[0].id;
}

// The shared customer's qualifying-order state BEFORE createFixture runs, queried up front so every
// assertion below can be exact instead of assuming a fresh customer with no history. createFixture
// reuses this same customer for its own pre-existing "captured" fixture order (submitted this week),
// so their prior state changes what that one extra order contributes to every retention delta:
//   - priorOrderCount 0 -> the new order makes them newly counted in totalCustomers (+1), but they
//     only have 1 order total so they don't become a repeat customer.
//   - priorOrderCount 1 -> already counted in totalCustomers (+0), but the new order is their 2nd,
//     so they newly become a repeat customer (+1 to repeatCustomers).
//   - priorOrderCount >= 2 -> already counted and already repeat either way (+0 to both).
//   - alreadyActiveThisWeek -> whether they already had a qualifying order in the target week before
//     this run, i.e. whether the new order actually changes activeCustomerCount for this week (+0 if
//     already active, +1 if not).
//   - alreadyReturning -> whether they already had a qualifying order in a week strictly BEFORE the
//     target week, i.e. whether the new order also makes them count as returning this week.
async function getSharedCustomerPriorState(database) {
  const customerId = await selectSharedCustomerId(database);
  const result = await database.query(`
    SELECT
      COUNT(*)::int AS prior_order_count,
      COUNT(*) FILTER (
        WHERE date_trunc('week', submitted_at AT TIME ZONE 'Asia/Taipei') = $2::date
      ) > 0 AS already_active_this_week,
      COUNT(*) FILTER (
        WHERE date_trunc('week', submitted_at AT TIME ZONE 'Asia/Taipei') < $2::date
      ) > 0 AS already_returning
    FROM orders
    WHERE customer_user_id = $1 AND payment_status = 'captured' AND status <> 'cancelled'
  `, [customerId, targetWeekStart]);
  const row = result.rows[0];
  return {
    priorOrderCount: row.prior_order_count,
    alreadyActiveThisWeek: row.already_active_this_week,
    alreadyReturning: row.already_returning,
  };
}

async function createFixture(database) {
  const [customerId, creator] = await Promise.all([
    selectSharedCustomerId(database),
    database.query("SELECT user_id FROM merchant_users WHERE status = 'active' LIMIT 1"),
  ]);
  assert.ok(creator.rows[0]?.user_id, "An active merchant user is required");
  const creatorId = creator.rows[0].user_id;
  const now = new Date();
  const iso = (offsetMinutes) => new Date(now.getTime() + offsetMinutes * 60_000).toISOString();

  await database.transaction(async (transaction) => {
    await transaction.query(
      "INSERT INTO merchants (id, name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)",
      [merchantId, `Admin stats proof merchant ${proofId}`, iso(0)],
    );
    // 'closed' keeps this store off every app screen for the few seconds it exists.
    await transaction.query(`
      INSERT INTO stores (id, merchant_id, name, address, phone, business_status, latitude, longitude, created_at, updated_at)
      VALUES ($1, $2, $3, 'test address', NULL, 'closed', 24.0, 120.0, $4, $4)
    `, [storeId, merchantId, `Admin stats proof store`, iso(0)]);

    for (const fixture of orders) {
      // Deadline far in the future so a running backend's schedulers never touch these mid-run.
      await transaction.query(`
        INSERT INTO group_buy_activities (
          id, store_id, created_by_user_id, title, status,
          start_at, deadline_at, pickup_start_at, pickup_end_at,
          maximum_cups, withdrawal_lock_minutes, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, 100, 30, $5, $5)
      `, [fixture.activityId, storeId, creatorId, `Admin stats proof ${fixture.key}`,
        iso(-120), iso(43200), iso(43260), iso(43320)]);
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference,
          total_cups, original_amount, final_amount, payment_status,
          authorization_status, merchant_acceptance_status, pickup_status,
          submitted_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'decline_original_price', $5, $6, $7, $8,
                  'authorized', 'accepted', $9, $10, $10)
      `, [fixture.orderId, fixture.activityId, customerId, fixture.status, fixture.cups,
        fixture.original, fixture.final, fixture.payment, fixture.pickup, fixture.submittedAt]);
    }

    // Marks $20 of the "captured" order (final_amount 70) as refunded, proving getBasicStatistics
    // nets this against revenue instead of counting the order's gross amount.
    await transaction.query(`
      INSERT INTO merchant_refund_marks (
        id, order_id, store_id, marked_by_user_id, amount, reason, status, idempotency_key, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 20, 'admin stats proof refund', 'active', $5, $6, $6)
    `, [`refund-mark-admin-stats-proof-${proofId}`, orders[0].orderId, storeId, creatorId, `admin-stats-proof-${proofId}`, iso(0)]);

    for (const customer of retentionCustomers) {
      await transaction.query(
        "INSERT INTO users (id, display_name, status, created_at, updated_at) VALUES ($1, $2, 'active', $3, $3)",
        [customer.userId, `Admin stats proof customer ${customer.key}`, iso(0)],
      );
    }
    const retentionCustomerByKey = new Map(retentionCustomers.map((customer) => [customer.key, customer.userId]));
    for (const fixture of retentionOrders) {
      await transaction.query(`
        INSERT INTO group_buy_activities (
          id, store_id, created_by_user_id, title, status,
          start_at, deadline_at, pickup_start_at, pickup_end_at,
          maximum_cups, withdrawal_lock_minutes, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, $8, 100, 30, $5, $5)
      `, [fixture.activityId, storeId, creatorId, `Admin stats proof ${fixture.key}`,
        iso(-120), iso(43200), iso(43260), iso(43320)]);
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference,
          total_cups, original_amount, final_amount, payment_status,
          authorization_status, merchant_acceptance_status, pickup_status,
          submitted_at, updated_at
        ) VALUES ($1, $2, $3, 'completed', 'decline_original_price', 1, 50, 50, 'captured',
                  'authorized', 'accepted', 'picked_up', $4, $4)
      `, [fixture.orderId, fixture.activityId, retentionCustomerByKey.get(fixture.customerKey), fixture.submittedAt]);
    }
  });
}

async function cleanup(database) {
  const orderIds = [...orders, ...retentionOrders].map((fixture) => fixture.orderId);
  const activityIds = [...orders, ...retentionOrders].map((fixture) => fixture.activityId);
  const customerIds = retentionCustomers.map((customer) => customer.userId);
  const refundMarkId = `refund-mark-admin-stats-proof-${proofId}`;
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM merchant_refund_marks WHERE id = $1", [refundMarkId]);
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
    await transaction.query("DELETE FROM stores WHERE id = $1", [storeId]);
    await transaction.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
    await transaction.query("DELETE FROM users WHERE id = ANY($1::text[])", [customerIds]);
  });
  const residue = await database.query(`
    SELECT
      (SELECT COUNT(*)::integer FROM merchant_refund_marks WHERE id = $6) AS refund_mark_count,
      (SELECT COUNT(*)::integer FROM orders WHERE id = ANY($1::text[])) AS order_count,
      (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($2::text[])) AS activity_count,
      (SELECT COUNT(*)::integer FROM stores WHERE id = $3) AS store_count,
      (SELECT COUNT(*)::integer FROM merchants WHERE id = $4) AS merchant_count,
      (SELECT COUNT(*)::integer FROM users WHERE id = ANY($5::text[])) AS customer_count
  `, [orderIds, activityIds, storeId, merchantId, customerIds, refundMarkId]);
  assert.deepEqual(residue.rows[0], { refund_mark_count: 0, order_count: 0, activity_count: 0, store_count: 0, merchant_count: 0, customer_count: 0 });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
