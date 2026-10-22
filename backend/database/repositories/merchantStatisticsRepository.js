"use strict";

const { createRuntimeDatabaseAdapter } = require("..");

const TOP_DRINKS_LIMIT = 3;
// ~2 calendar months. Deliberately its own constant, not shared with adminStatisticsRepository.js's
// platform-wide WEEKLY_TREND_WEEKS (=8) -- this window backs both the merchant's own trend chart and
// the admin per-store drill-down that reuses this same query, neither of which sits next to the
// platform-wide admin chart, so there's no "two windows on one page" consistency requirement forcing
// them to match (see adminStatisticsRepository.js's own comment on why ITS two charts must match).
// Was 13 (~3 months); narrowed after the mobile chart's bars got too cramped at 13-wide.
const WEEKLY_TREND_WEEKS = 9;

// The orders that count as this store's sales -- one definition shared by every figure below so the
// revenue, discount and top-drinks numbers always describe the same set of orders:
//   - the order belongs to an activity of THIS store (the only tenant boundary; $1 is that store id)
//   - payment_status = 'captured' -> money was really collected; authorized/voided/failed orders
//     never produced revenue. Scheme B self-reported refunds (merchant_refund_marks, 2026-10-21)
//     never flip this back to 'refunded', even for a full refund -- revenue is netted against
//     those marks below instead of relying on a status change to drop the order out.
//   - orders.status <> 'cancelled' and activity.status <> 'cancelled' -> an admin can cancel an
//     already-settled activity, which leaves its captured orders untouched (they are skipped by the
//     cancel flow) even though the drinks will never be made, so they are not counted as sales.
// Unclaimed orders (pickup_status 'expired') DO count: the customer was charged and, by the pickup
// rule, is not refunded automatically, so the store kept that money.
const SALES_ORDER_FILTER = `
  activity.store_id = $1
  AND activity.status <> 'cancelled'
  AND orders.payment_status = 'captured'
  AND orders.status <> 'cancelled'
  AND orders.final_amount IS NOT NULL
`;

// One store's figures. The store id is always authorized against the caller's token by the route
// before it gets here; every query filters on it, so a store can only ever see its own rows.
async function getStoreStatisticsPostgres(database, storeId) {
  const [salesResult, activityResult, drinksResult] = await Promise.all([
    // Refunds (partial or full -- see the comment above on SALES_ORDER_FILTER) are subtracted from
    // revenue, since that's money the store gave back; the discount is original_amount - final_amount
    // and is unaffected by refunds. Order count and discount totals still count a fully-refunded
    // order -- whether those should also exclude it is a separate, not-yet-decided product question
    // (see docs/payment-rules-and-flow.md "退款"); this only fixes the revenue figure itself.
    // Two independent refund sources both net against revenue here: merchant_refund_marks (scheme B,
    // self-reported, never flips payment_status) and the still-live admin-approval payment_refunds
    // path (a PARTIAL refund there also never flips payment_status -- only a full refund does, which
    // already drops the order out of SALES_ORDER_FILTER). Summed separately per order and added
    // together rather than UNIONed, since the two tables can never both have rows for the same order
    // (payment_refunds is the old, now-admin-only path; merchant_refund_marks is the new merchant path).
    database.query(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(orders.final_amount), 0) AS gross_revenue,
        COALESCE(SUM(mark_refund.refunded_amount), 0) + COALESCE(SUM(provider_refund.refunded_amount), 0) AS refund_total,
        COALESCE(SUM(orders.original_amount - orders.final_amount), 0) AS discount_given_total
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS refunded_amount
        FROM merchant_refund_marks
        WHERE status = 'active'
        GROUP BY order_id
      ) mark_refund ON mark_refund.order_id = orders.id
      LEFT JOIN (
        SELECT order_id, SUM(refund_amount) AS refunded_amount
        FROM payment_refunds
        WHERE status = 'refunded'
        GROUP BY order_id
      ) provider_refund ON provider_refund.order_id = orders.id
      WHERE ${SALES_ORDER_FILTER}
    `, [storeId]),
    // Success = the group buy reached its first discount tier. Only settled activities count:
    // still-recruiting ones have no outcome yet, and store-cancelled ones never reach settlement.
    // An activity cancelled AFTER it settled is left out too, so this figure and the sales figures
    // above describe the same set of activities.
    database.query(`
      SELECT
        COUNT(*) FILTER (WHERE settlement.outcome = 'qualified') AS qualified_count,
        COUNT(*) FILTER (WHERE settlement.outcome = 'failed') AS failed_count
      FROM activity_settlements settlement
      JOIN group_buy_activities activity ON activity.id = settlement.activity_id
      WHERE activity.store_id = $1
        AND activity.status <> 'cancelled'
    `, [storeId]),
    database.query(`
      SELECT item.item_name_snapshot AS name, SUM(item.quantity) AS cups
      FROM order_items item
      JOIN orders ON orders.id = item.order_id
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE ${SALES_ORDER_FILTER}
      GROUP BY item.item_name_snapshot
      ORDER BY cups DESC, name ASC
      LIMIT $2
    `, [storeId, TOP_DRINKS_LIMIT]),
  ]);

  const sales = salesResult.rows[0] || {};
  const activities = activityResult.rows[0] || {};
  const qualifiedActivityCount = Number(activities.qualified_count || 0);
  const settledActivityCount = qualifiedActivityCount + Number(activities.failed_count || 0);

  return {
    totalRevenue: Number(sales.gross_revenue || 0) - Number(sales.refund_total || 0),
    orderCount: Number(sales.order_count || 0),
    discountGivenTotal: Number(sales.discount_given_total || 0),
    settledActivityCount,
    qualifiedActivityCount,
    qualifiedRate: settledActivityCount > 0 ? qualifiedActivityCount / settledActivityCount : null,
    topDrinks: drinksResult.rows.map((row) => ({ name: row.name, cups: Number(row.cups) })),
  };
}

// One row per calendar week (Monday start, Asia/Taipei) over the trailing WEEKLY_TREND_WEEKS weeks,
// for just this store -- same SALES_ORDER_FILTER as the figures above, so "which orders count" never
// drifts between the store's headline numbers and its trend. week_series generates every week in the
// window up front and LEFT JOINs the real orders onto it, so a week with zero orders still comes back
// as a zero-value row instead of being silently absent -- a chart drawing "one bar per week" needs an
// actual row per week, not just per week that happened to have activity, or slow weeks disappear from
// the x-axis entirely instead of showing as a short bar. Revenue/discount here are not refund-adjusted
// (a per-week refund allocation is ambiguous -- a refund can land in a different week than the
// original order); only the point-in-time getStoreStatistics total subtracts refunds.
async function getStoreWeeklyTrendPostgres(database, storeId) {
  const result = await database.query(`
    WITH week_series AS (
      SELECT generate_series(
        date_trunc('week', now() AT TIME ZONE 'Asia/Taipei') - make_interval(weeks => $2::int - 1),
        date_trunc('week', now() AT TIME ZONE 'Asia/Taipei'),
        interval '1 week'
      ) AS week_start
    ),
    order_data AS (
      SELECT
        date_trunc('week', orders.submitted_at AT TIME ZONE 'Asia/Taipei') AS week_start,
        COUNT(*) AS order_count,
        COALESCE(SUM(orders.final_amount), 0) AS revenue,
        COALESCE(SUM(orders.original_amount - orders.final_amount), 0) AS discount_amount
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE ${SALES_ORDER_FILTER}
        -- Deliberately NOT "date_trunc('week', now() AT TIME ZONE 'Asia/Taipei') - make_interval(...)"
        -- here: that expression is a naive timestamp (AT TIME ZONE strips the zone), and comparing a
        -- naive timestamp to submitted_at (timestamptz) makes Postgres cast it back using the
        -- session's own timezone (UTC on Azure), not Asia/Taipei -- silently shifting the boundary by
        -- the UTC+8 offset and dropping real orders from the oldest week. Comparing two timestamptz
        -- values instead (like adminStatisticsRepository.js's getWeeklyTrendPostgres/getCustomerRetentionPostgres
        -- already do) has no such ambiguity; using the full week count here (not $2 - 1) makes this
        -- boundary a few days earlier than week_series' own earliest row needs, which is fine since
        -- order_data rows that fall outside week_series just don't match anything in the LEFT JOIN below.
        AND orders.submitted_at >= now() - make_interval(weeks => $2::int)
      GROUP BY 1
    )
    SELECT
      to_char(week_series.week_start, 'YYYY-MM-DD') AS week_start,
      COALESCE(order_data.order_count, 0) AS order_count,
      COALESCE(order_data.revenue, 0) AS revenue,
      COALESCE(order_data.discount_amount, 0) AS discount_amount
    FROM week_series
    LEFT JOIN order_data ON order_data.week_start = week_series.week_start
    ORDER BY week_series.week_start
  `, [storeId, WEEKLY_TREND_WEEKS]);

  return result.rows.map((row) => ({
    weekStart: row.week_start,
    orderCount: Number(row.order_count),
    revenue: Number(row.revenue),
    discountAmount: Number(row.discount_amount),
  }));
}

function createMerchantStatisticsRepository(input = {}) {
  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    getStoreStatistics: (storeId) => getStoreStatisticsPostgres(database, storeId),
    getStoreWeeklyTrend: (storeId) => getStoreWeeklyTrendPostgres(database, storeId),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

module.exports = {
  createMerchantStatisticsRepository,
};
