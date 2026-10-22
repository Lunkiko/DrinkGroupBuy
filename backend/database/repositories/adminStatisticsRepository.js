"use strict";

const { createRuntimeDatabaseAdapter } = require("..");

// Activities still in draft/recruiting haven't reached an outcome yet, so they're excluded from
// the success-rate denominator -- including them would understate the rate for no reason (they
// aren't failures, they just haven't finished).
const SUCCESSFUL_ACTIVITY_STATUSES = ["confirmed", "ordering", "ready_for_pickup", "completed"];
const UNSUCCESSFUL_ACTIVITY_STATUSES = ["failed", "cancelled"];
const TOP_STORES_LIMIT = 10;
const WEEKLY_TREND_WEEKS = 8;

// Every "which week" / "which hour" bucket below is computed in Asia/Taipei wall-clock time, not
// the database server's own timezone (Azure's managed Postgres defaults to UTC) -- an admin reading
// "顧客活躍時段" only cares what hour it was for the actual customers and stores, all in Taiwan.

function createAdminStatisticsRepository(input = {}) {
  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    getBasicStatistics: () => getBasicStatisticsPostgres(database),
    getWeeklyTrend: () => getWeeklyTrendPostgres(database),
    getPeakHours: () => getPeakHoursPostgres(database),
    getCustomerRetention: () => getCustomerRetentionPostgres(database),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

async function getBasicStatisticsPostgres(database) {
  const [activityResult, orderResult, topStoresResult] = await Promise.all([
    database.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = ANY($1::text[])) AS successful_count,
        COUNT(*) FILTER (WHERE status = ANY($2::text[])) AS unsuccessful_count,
        COUNT(*) AS total_count
      FROM group_buy_activities
    `, [SUCCESSFUL_ACTIVITY_STATUSES, UNSUCCESSFUL_ACTIVITY_STATUSES]),
    // total_revenue is netted against both refund sources that never flip payment_status back off
    // 'captured' -- merchant_refund_marks (scheme B, self-reported) and the still-live admin-approval
    // payment_refunds path -- the same two sources and the same "sum separately, add together" shape
    // merchantStatisticsRepository.js's getStoreStatisticsPostgres already uses for the per-store
    // figure. average_order_value is deliberately left un-netted: it describes the size distribution
    // of captured orders, not realized revenue, so a later refund on one of them doesn't change it.
    database.query(`
      SELECT
        COUNT(*) AS total_orders,
        COUNT(*) FILTER (WHERE payment_status = 'captured') AS captured_orders,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_orders,
        COALESCE(SUM(orders.final_amount) FILTER (WHERE orders.payment_status = 'captured'), 0)
          - COALESCE(SUM(mark_refund.refunded_amount) FILTER (WHERE orders.payment_status = 'captured'), 0)
          - COALESCE(SUM(provider_refund.refunded_amount) FILTER (WHERE orders.payment_status = 'captured'), 0)
          AS total_revenue,
        COALESCE(AVG(orders.final_amount) FILTER (WHERE orders.payment_status = 'captured'), 0) AS average_order_value
      FROM orders
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
    `),
    // Same refund netting as above, per store.
    database.query(`
      SELECT
        store_record.id,
        store_record.name,
        COUNT(DISTINCT activity.id) AS activity_count,
        COUNT(order_record.id) FILTER (WHERE order_record.payment_status = 'captured') AS captured_order_count,
        COALESCE(SUM(order_record.final_amount) FILTER (WHERE order_record.payment_status = 'captured'), 0)
          - COALESCE(SUM(mark_refund.refunded_amount) FILTER (WHERE order_record.payment_status = 'captured'), 0)
          - COALESCE(SUM(provider_refund.refunded_amount) FILTER (WHERE order_record.payment_status = 'captured'), 0)
          AS revenue
      FROM stores store_record
      JOIN group_buy_activities activity ON activity.store_id = store_record.id
      LEFT JOIN orders order_record ON order_record.activity_id = activity.id
      LEFT JOIN (
        SELECT order_id, SUM(amount) AS refunded_amount
        FROM merchant_refund_marks
        WHERE status = 'active'
        GROUP BY order_id
      ) mark_refund ON mark_refund.order_id = order_record.id
      LEFT JOIN (
        SELECT order_id, SUM(refund_amount) AS refunded_amount
        FROM payment_refunds
        WHERE status = 'refunded'
        GROUP BY order_id
      ) provider_refund ON provider_refund.order_id = order_record.id
      GROUP BY store_record.id, store_record.name
      ORDER BY revenue DESC, activity_count DESC
      LIMIT $1
    `, [TOP_STORES_LIMIT]),
  ]);

  const activityRow = activityResult.rows[0];
  const resolvedActivityCount = Number(activityRow.successful_count) + Number(activityRow.unsuccessful_count);
  const orderRow = orderResult.rows[0];

  return {
    activities: {
      totalCount: Number(activityRow.total_count),
      successfulCount: Number(activityRow.successful_count),
      unsuccessfulCount: Number(activityRow.unsuccessful_count),
      successRate: resolvedActivityCount > 0
        ? Number(activityRow.successful_count) / resolvedActivityCount
        : null,
    },
    orders: {
      totalOrders: Number(orderRow.total_orders),
      capturedOrders: Number(orderRow.captured_orders),
      cancelledOrders: Number(orderRow.cancelled_orders),
      totalRevenue: Number(orderRow.total_revenue),
      averageOrderValue: Math.round(Number(orderRow.average_order_value)),
    },
    topStores: topStoresResult.rows.map((row) => ({
      id: row.id,
      name: row.name,
      activityCount: Number(row.activity_count),
      capturedOrderCount: Number(row.captured_order_count),
      revenue: Number(row.revenue),
    })),
  };
}

// One row per calendar week (Monday start, Asia/Taipei) over the trailing WEEKLY_TREND_WEEKS
// weeks. revenue/discountAmount only count captured orders, matching getBasicStatistics's existing
// convention; discountAmount is original minus final for those same orders.
async function getWeeklyTrendPostgres(database) {
  const result = await database.query(`
    SELECT
      to_char(date_trunc('week', submitted_at AT TIME ZONE 'Asia/Taipei'), 'YYYY-MM-DD') AS week_start,
      COUNT(*) FILTER (WHERE payment_status = 'captured') AS order_count,
      COALESCE(SUM(final_amount) FILTER (WHERE payment_status = 'captured'), 0) AS revenue,
      COALESCE(SUM(original_amount - final_amount) FILTER (WHERE payment_status = 'captured'), 0) AS discount_amount
    FROM orders
    WHERE submitted_at >= now() - make_interval(weeks => $1::int)
    GROUP BY 1
    ORDER BY 1
  `, [WEEKLY_TREND_WEEKS]);

  return result.rows.map((row) => ({
    weekStart: row.week_start,
    orderCount: Number(row.order_count),
    revenue: Number(row.revenue),
    discountAmount: Number(row.discount_amount),
  }));
}

// Every hour of the day, 0-23, filled in even where no order was ever submitted. Counts every
// order regardless of outcome (captured, cancelled, ...) -- unlike revenue, "when are customers
// actively placing orders" is a behavioural signal that a later cancellation doesn't erase.
async function getPeakHoursPostgres(database) {
  const result = await database.query(`
    SELECT
      EXTRACT(HOUR FROM submitted_at AT TIME ZONE 'Asia/Taipei')::int AS hour_of_day,
      COUNT(*) AS order_count
    FROM orders
    GROUP BY 1
    ORDER BY 1
  `);

  const countByHour = new Map(result.rows.map((row) => [Number(row.hour_of_day), Number(row.order_count)]));
  return Array.from({ length: 24 }, (_, hour) => ({ hour, orderCount: countByHour.get(hour) ?? 0 }));
}

// "Repeat purchase" and "returning" both mean the same thing here: a customer with more than one
// qualifying order. This is DELIBERATELY a stricter filter than getBasicStatisticsPostgres's
// captured_orders / getWeeklyTrendPostgres's order_count above (payment_status = 'captured' only,
// no status exclusion) -- a retention metric about "did this customer actually come back" shouldn't
// count a visit whose activity was later cancelled, even though the platform-wide revenue/order
// counts above intentionally do still count it as a captured order for those different questions.
const QUALIFYING_RETENTION_ORDER_FILTER = "payment_status = 'captured' AND status <> 'cancelled'";

async function getCustomerRetentionPostgres(database) {
  const [overallResult, weeklyResult] = await Promise.all([
    database.query(`
      SELECT
        COUNT(*) AS total_customers,
        COUNT(*) FILTER (WHERE order_count >= 2) AS repeat_customers
      FROM (
        SELECT customer_user_id, COUNT(*) AS order_count
        FROM orders
        WHERE ${QUALIFYING_RETENTION_ORDER_FILTER}
        GROUP BY customer_user_id
      ) per_customer
    `),
    // first_week is a window function over the customer's FULL order history (every qualifying row,
    // unfiltered by the trailing-weeks window below) -- a customer whose first order was months ago
    // and who reappears this week must count as returning, not new. Only the outer WHERE windows the
    // final rows, after first_week is already computed. That outer WHERE deliberately matches
    // getWeeklyTrendPostgres's own submitted_at-based window (not a calendar-aligned one) so the two
    // "近 8 週" charts on the admin statistics page cover the exact same set of weeks.
    database.query(`
      WITH qualifying_orders AS (
        SELECT
          customer_user_id,
          submitted_at,
          date_trunc('week', submitted_at AT TIME ZONE 'Asia/Taipei') AS week_start,
          MIN(date_trunc('week', submitted_at AT TIME ZONE 'Asia/Taipei'))
            OVER (PARTITION BY customer_user_id) AS first_week
        FROM orders
        WHERE ${QUALIFYING_RETENTION_ORDER_FILTER}
      )
      SELECT
        to_char(week_start, 'YYYY-MM-DD') AS week_start,
        COUNT(DISTINCT customer_user_id) AS active_customer_count,
        COUNT(DISTINCT customer_user_id) FILTER (WHERE week_start > first_week) AS returning_customer_count
      FROM qualifying_orders
      WHERE submitted_at >= now() - make_interval(weeks => $1::int)
      GROUP BY week_start
      ORDER BY week_start
    `, [WEEKLY_TREND_WEEKS]),
  ]);

  const overallRow = overallResult.rows[0];
  const totalCustomers = Number(overallRow.total_customers);
  const repeatCustomers = Number(overallRow.repeat_customers);

  return {
    repeatPurchaseRate: totalCustomers > 0 ? repeatCustomers / totalCustomers : null,
    totalCustomers,
    repeatCustomers,
    weeklyReturning: weeklyResult.rows.map((row) => {
      const activeCustomerCount = Number(row.active_customer_count);
      const returningCustomerCount = Number(row.returning_customer_count);
      return {
        weekStart: row.week_start,
        activeCustomerCount,
        returningCustomerCount,
        returningRate: returningCustomerCount / activeCustomerCount,
      };
    }),
  };
}

module.exports = {
  createAdminStatisticsRepository,
};
