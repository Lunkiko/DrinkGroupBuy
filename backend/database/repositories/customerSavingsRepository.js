"use strict";

const { createRuntimeDatabaseAdapter } = require("..");

// An order only counts toward "money saved" once the customer was really charged the discounted
// price and still holds (or has received) the drinks:
//   - payment_status = 'captured'  -> the discounted final_amount was actually charged.
//     pending/authorized/voided/failed never had a final price to compare against. Scheme B
//     self-reported refunds (merchant_refund_marks, 2026-10-21) never flip this back to
//     'refunded' -- unlike the old provider-executed refund, a merchant's own mark is the only
//     signal a full refund happened, so a fully-marked order is excluded by the EXISTS below
//     instead of by this status check.
//   - status <> 'cancelled'        -> cancelled orders are not a purchase.
//   - pickup_status <> expired     -> an unclaimed order keeps payment_status = 'captured' (no
//     refund, see pickupCredentialRepository), but the customer never got the drink, so nothing
//     was saved.
//   - activity.status <> 'cancelled' -> an admin can cancel an already-settled activity; that flow
//     skips captured orders (merchantGroupBuyActivityCancelRepository), so they stay captured and
//     never expire, yet the drinks can no longer be picked up.
// Partial refunds are deliberately NOT subtracted: a refund is compensation for a problem, not a
// change to the group-buy discount, so savings stay original_amount - final_amount.
// The sum runs in SQL because the customer-orders list API is cursor-paginated; summing a page of
// it on the phone would silently miss older orders.
async function getCustomerSavingsSummaryPostgres(database, customerUserId) {
  const result = await database.query(`
    SELECT
      COALESCE(SUM(orders.original_amount - orders.final_amount), 0) AS total_saved_amount,
      COUNT(*) AS saved_order_count,
      COALESCE(SUM(orders.total_cups), 0) AS saved_cup_count
    FROM orders
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    WHERE orders.customer_user_id = $1
      AND orders.payment_status = 'captured'
      AND orders.status <> 'cancelled'
      AND orders.pickup_status IN ('not_ready', 'ready', 'picked_up')
      AND orders.final_amount IS NOT NULL
      AND orders.original_amount > orders.final_amount
      AND activity.status <> 'cancelled'
      AND orders.final_amount > COALESCE((
        SELECT SUM(mark.amount) FROM merchant_refund_marks mark
        WHERE mark.order_id = orders.id AND mark.status = 'active'
      ), 0)
  `, [customerUserId]);

  const row = result.rows[0] || {};
  return {
    totalSavedAmount: Number(row.total_saved_amount || 0),
    savedOrderCount: Number(row.saved_order_count || 0),
    savedCupCount: Number(row.saved_cup_count || 0),
  };
}

function createCustomerSavingsRepository(input = {}) {
  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    getSavingsSummary: (customerUserId) => getCustomerSavingsSummaryPostgres(database, customerUserId),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

module.exports = {
  createCustomerSavingsRepository,
};
