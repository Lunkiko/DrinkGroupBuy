"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdminStatisticsRepository } = require("./adminStatisticsRepository");

// retentionWeekly's query also contains "date_trunc('week'" (same as weeklyTrend's), so it must be
// checked first via its own unique "first_week" CTE name.
function createFakeDatabase({
  weeklyTrend = [], peakHours = [], retentionOverall = [], retentionWeekly = [],
  basicActivities = [{ successful_count: "0", unsuccessful_count: "0", total_count: "0" }],
  basicOrders = [{ total_orders: "0", captured_orders: "0", cancelled_orders: "0", total_revenue: "0", average_order_value: "0" }],
  basicTopStores = [],
} = {}) {
  const queries = [];
  return {
    queries,
    database: {
      async query(sql, parameters = []) {
        const statement = String(sql).replace(/\s+/g, " ").trim();
        queries.push({ statement, parameters });
        if (statement.includes("EXTRACT(HOUR FROM submitted_at")) return { rows: peakHours };
        if (statement.includes("repeat_customers")) return { rows: retentionOverall };
        if (statement.includes("first_week")) return { rows: retentionWeekly };
        if (statement.includes("date_trunc('week'")) return { rows: weeklyTrend };
        if (statement.includes("successful_count")) return { rows: basicActivities };
        if (statement.includes("store_record.id")) return { rows: basicTopStores };
        if (statement.includes("total_orders")) return { rows: basicOrders };
        throw new Error(`Unexpected SQL: ${statement}`);
      },
    },
  };
}

test("weekly trend maps each row and keeps the given week order", async () => {
  const fake = createFakeDatabase({
    weeklyTrend: [
      { week_start: "2026-09-07", order_count: "5", revenue: "350", discount_amount: "70" },
      { week_start: "2026-09-14", order_count: "0", revenue: "0", discount_amount: "0" },
    ],
  });
  const trend = await createAdminStatisticsRepository({ database: fake.database }).getWeeklyTrend();

  assert.deepEqual(trend, [
    { weekStart: "2026-09-07", orderCount: 5, revenue: 350, discountAmount: 70 },
    { weekStart: "2026-09-14", orderCount: 0, revenue: 0, discountAmount: 0 },
  ]);
});

test("weekly trend query buckets in Asia/Taipei time and looks back a bounded window", async () => {
  const fake = createFakeDatabase();
  await createAdminStatisticsRepository({ database: fake.database }).getWeeklyTrend();

  assert.equal(fake.queries.length, 1);
  const [query] = fake.queries;
  assert.match(query.statement, /AT TIME ZONE 'Asia\/Taipei'/);
  assert.match(query.statement, /payment_status = 'captured'/);
  assert.match(query.statement, /submitted_at >= now\(\) - make_interval\(weeks => \$1::int\)/);
  assert.deepEqual(query.parameters, [8]);
});

test("basic statistics' total revenue and per-store revenue net out both refund sources, same shape as merchantStatisticsRepository.js", async () => {
  const fake = createFakeDatabase();
  await createAdminStatisticsRepository({ database: fake.database }).getBasicStatistics();

  const orderQuery = fake.queries.find((query) => query.statement.includes("total_orders"));
  const topStoresQuery = fake.queries.find((query) => query.statement.includes("store_record.id"));

  for (const query of [orderQuery, topStoresQuery]) {
    assert.match(query.statement, /LEFT JOIN \( SELECT order_id, SUM\(amount\) AS refunded_amount FROM merchant_refund_marks WHERE status = 'active' GROUP BY order_id \) mark_refund/);
    assert.match(query.statement, /LEFT JOIN \( SELECT order_id, SUM\(refund_amount\) AS refunded_amount FROM payment_refunds WHERE status = 'refunded' GROUP BY order_id \) provider_refund/);
  }
  assert.match(orderQuery.statement, /- COALESCE\(SUM\(mark_refund\.refunded_amount\).*- COALESCE\(SUM\(provider_refund\.refunded_amount\).*AS total_revenue/s);
  assert.match(topStoresQuery.statement, /- COALESCE\(SUM\(mark_refund\.refunded_amount\).*- COALESCE\(SUM\(provider_refund\.refunded_amount\).*AS revenue/s);
  assert.match(topStoresQuery.statement, /ORDER BY revenue DESC/);
  // average_order_value is deliberately NOT netted against refunds (order size, not realized revenue).
  const averageExpression = orderQuery.statement.match(/COALESCE\(AVG\(.*?\) AS average_order_value/s)[0];
  assert.ok(!averageExpression.includes("refund"));
});

test("basic statistics maps the already-netted total_revenue straight through", async () => {
  const fake = createFakeDatabase({
    basicOrders: [{ total_orders: "10", captured_orders: "8", cancelled_orders: "1", total_revenue: "350", average_order_value: "50" }],
    basicTopStores: [{ id: "store-001", name: "青山手作茶", activity_count: "3", captured_order_count: "8", revenue: "350" }],
  });
  const stats = await createAdminStatisticsRepository({ database: fake.database }).getBasicStatistics();

  assert.equal(stats.orders.totalRevenue, 350);
  assert.equal(stats.topStores[0].revenue, 350);
});

test("peak hours fills in every hour of the day, even ones with no orders", async () => {
  const fake = createFakeDatabase({
    peakHours: [
      { hour_of_day: "9", order_count: "3" },
      { hour_of_day: "22", order_count: "1" },
    ],
  });
  const hours = await createAdminStatisticsRepository({ database: fake.database }).getPeakHours();

  assert.equal(hours.length, 24);
  assert.deepEqual(hours[0], { hour: 0, orderCount: 0 });
  assert.deepEqual(hours[9], { hour: 9, orderCount: 3 });
  assert.deepEqual(hours[22], { hour: 22, orderCount: 1 });
  assert.deepEqual(hours[23], { hour: 23, orderCount: 0 });
});

test("peak hours query counts every order regardless of status, unlike the revenue queries", async () => {
  const fake = createFakeDatabase();
  await createAdminStatisticsRepository({ database: fake.database }).getPeakHours();

  assert.equal(fake.queries.length, 1);
  const [query] = fake.queries;
  assert.match(query.statement, /AT TIME ZONE 'Asia\/Taipei'/);
  assert.ok(!query.statement.includes("payment_status"), "peak hours must not filter by payment status");
  assert.ok(!query.statement.includes("WHERE"), "peak hours must not filter out any order");
});

test("customer retention combines the overall repeat rate with the weekly returning-rate series", async () => {
  const fake = createFakeDatabase({
    retentionOverall: [{ total_customers: "20", repeat_customers: "5" }],
    retentionWeekly: [
      { week_start: "2026-09-07", active_customer_count: "10", returning_customer_count: "4" },
      { week_start: "2026-09-14", active_customer_count: "6", returning_customer_count: "6" },
    ],
  });
  const retention = await createAdminStatisticsRepository({ database: fake.database }).getCustomerRetention();

  assert.deepEqual(retention, {
    repeatPurchaseRate: 0.25,
    totalCustomers: 20,
    repeatCustomers: 5,
    weeklyReturning: [
      { weekStart: "2026-09-07", activeCustomerCount: 10, returningCustomerCount: 4, returningRate: 0.4 },
      { weekStart: "2026-09-14", activeCustomerCount: 6, returningCustomerCount: 6, returningRate: 1 },
    ],
  });
});

test("customer retention returns null (not NaN) for the overall rate when nobody has ordered yet", async () => {
  const fake = createFakeDatabase({ retentionOverall: [{ total_customers: "0", repeat_customers: "0" }] });
  const retention = await createAdminStatisticsRepository({ database: fake.database }).getCustomerRetention();
  assert.equal(retention.repeatPurchaseRate, null);
  assert.deepEqual(retention.weeklyReturning, []);
});

test("customer retention's weekly query uses the same captured/non-cancelled order filter as every other statistic, and only windows the final grouping (not first_week)", async () => {
  const fake = createFakeDatabase({ retentionOverall: [{ total_customers: "0", repeat_customers: "0" }] });
  await createAdminStatisticsRepository({ database: fake.database }).getCustomerRetention();

  const overallQuery = fake.queries.find((query) => query.statement.includes("repeat_customers"));
  const weeklyQuery = fake.queries.find((query) => query.statement.includes("first_week"));

  assert.match(overallQuery.statement, /payment_status = 'captured' AND status <> 'cancelled'/);
  assert.match(weeklyQuery.statement, /AT TIME ZONE 'Asia\/Taipei'/);
  assert.match(weeklyQuery.statement, /payment_status = 'captured' AND status <> 'cancelled'/);
  // Same window expression as getWeeklyTrendPostgres (backend/server.js's other "近 8 週" chart), not
  // a calendar-aligned one -- so both charts on the admin statistics page cover the same set of weeks.
  assert.deepEqual(weeklyQuery.parameters, [8]);
  assert.match(weeklyQuery.statement, /submitted_at >= now\(\) - make_interval\(weeks => \$1::int\)/);
  // Guards the same bug class merchantStatisticsRepository.js's getStoreWeeklyTrendPostgres was fixed
  // for: comparing submitted_at (timestamptz) against something derived from AT TIME ZONE (a naive
  // timestamp) makes Postgres cast it back using the session's own timezone, not Asia/Taipei, silently
  // shifting this boundary by hours and dropping real orders near the edge of the window.
  assert.ok(
    !/submitted_at\s*>=\s*date_trunc/.test(weeklyQuery.statement),
    "the trailing-window filter must not compare submitted_at (timestamptz) to an AT TIME ZONE-derived (naive) value",
  );

  // first_week is a window function (MIN(...) OVER (PARTITION BY customer_user_id)) computed inside
  // qualifying_orders, which itself has no trailing-weeks filter -- only WHERE payment_status/status.
  // The trailing-window filter above is the CTE's own outer SELECT, applied AFTER first_week is
  // already computed from the customer's full history, not before.
  const qualifyingOrdersCte = weeklyQuery.statement.match(/qualifying_orders AS \( (.*?) \)\s*SELECT/)[1];
  assert.match(qualifyingOrdersCte, /MIN\(.*\) OVER \(PARTITION BY customer_user_id\) AS first_week/);
  assert.ok(!qualifyingOrdersCte.includes("make_interval"), "qualifying_orders (and so first_week) must not be windowed to the trailing weeks");
});
