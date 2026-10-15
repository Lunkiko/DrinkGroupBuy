"use strict";

// Real-database proof for two pickup behaviours that unit tests with a fake database cannot show:
//   1. Two mark-ready calls running at the same moment both succeed with different pickup codes. randomInt is
//      forced to return the same number for its first two calls and a barrier makes both "is this code taken?"
//      checks happen before either insert. Without the advisory lock in generateAvailablePostgresCode the later
//      INSERT hits the unique index idx_pickup_credentials_active_code and that whole mark-ready call fails;
//      with it, the second call waits, sees the committed code and picks another.
//   2. The SQL pre-filters in listDueActivities and claimPickupReminders return exactly the activities the
//      JavaScript expiry rule (min(pickup start + 3 h, pickup end)) says they should.
// Writes only rows with generated ids and removes them afterwards; run it through scripts/with-temp-schema.js
// (npm run test:db) so even those rows never touch a database that matters.

const crypto = require("node:crypto");
const realRandomInt = crypto.randomInt;
let forcedCodeCalls = 0;
// Must be patched before the repository is loaded: it destructures randomInt at require time.
crypto.randomInt = (...args) => (forcedCodeCalls++ < 2 ? 123456 : realRandomInt(...args));

const assert = require("node:assert/strict");
const { createRuntimeDatabaseAdapter } = require("../backend/database");
const { createPickupCredentialRepository } = require("../backend/database/repositories/pickupCredentialRepository");
const { markGroupBuyActivityReadyForPickup } = require("../backend/pickup/credentialService");

const proofId = crypto.randomUUID();
const HOUR = 60 * 60_000;
const MINUTE = 60_000;

const activities = {
  codeA: { id: `activity-code-a-${proofId}`, orderId: `order-code-a-${proofId}`, status: "ordering", pickupStartOffset: -10 * MINUTE, pickupEndOffset: HOUR, orderPickupStatus: "not_ready" },
  codeB: { id: `activity-code-b-${proofId}`, orderId: `order-code-b-${proofId}`, status: "ordering", pickupStartOffset: -10 * MINUTE, pickupEndOffset: HOUR, orderPickupStatus: "not_ready" },
  // expiry = pickup end (already past)
  dueByEnd: { id: `activity-due-end-${proofId}`, orderId: `order-due-end-${proofId}`, status: "ready_for_pickup", pickupStartOffset: -2 * HOUR, pickupEndOffset: -10 * MINUTE, orderPickupStatus: "ready" },
  // expiry = pickup start + 3 h (already past) although the pickup end is still in the future
  dueByStart: { id: `activity-due-start-${proofId}`, orderId: `order-due-start-${proofId}`, status: "ready_for_pickup", pickupStartOffset: -4 * HOUR, pickupEndOffset: 2 * HOUR, orderPickupStatus: "ready" },
  // expiry two hours away: neither due nor closing soon
  notDue: { id: `activity-not-due-${proofId}`, orderId: `order-not-due-${proofId}`, status: "ready_for_pickup", pickupStartOffset: -HOUR, pickupEndOffset: 2 * HOUR, orderPickupStatus: "ready" },
  // expiry = pickup start + 3 h, 6 minutes from now
  soonByStart: { id: `activity-soon-start-${proofId}`, orderId: `order-soon-start-${proofId}`, status: "ready_for_pickup", pickupStartOffset: -3 * HOUR + 6 * MINUTE, pickupEndOffset: 3 * HOUR, orderPickupStatus: "ready" },
  // expiry = pickup end, 10 minutes from now
  soonByEnd: { id: `activity-soon-end-${proofId}`, orderId: `order-soon-end-${proofId}`, status: "ready_for_pickup", pickupStartOffset: -HOUR, pickupEndOffset: 10 * MINUTE, orderPickupStatus: "ready" },
};
const activityIds = Object.values(activities).map((activity) => activity.id);
const orderIds = Object.values(activities).map((activity) => activity.orderId);

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log("PostgreSQL pickup concurrency smoke skipped: DATABASE_URL is not set.");
    return;
  }
  const database = createRuntimeDatabaseAdapter({ runtime: "postgres" });
  const repository = createPickupCredentialRepository({ runtime: "postgres", database: withCodeCheckBarrier(database) });
  try {
    const { merchantUserId, customerUserId } = await createFixture(database);

    // 1. Two simultaneous mark-ready calls must not share a pickup code.
    const results = await Promise.all([activities.codeA, activities.codeB].map((activity) =>
      markGroupBuyActivityReadyForPickup(activity.id, { actorUserId: merchantUserId, pickupCredentialRepository: repository })));
    for (const result of results) assert.equal(result.status, "ready_for_pickup", `mark-ready failed: ${JSON.stringify(result)}`);
    const codes = (await database.query(
      "SELECT pickup_code FROM pickup_credentials WHERE order_id = ANY($1::text[]) ORDER BY order_id", [[activities.codeA.orderId, activities.codeB.orderId]],
    )).rows.map((row) => row.pickup_code);
    assert.equal(codes.length, 2);
    console.log(`codes issued: ${codes.join(" and ")} (random number generator was called ${forcedCodeCalls} times)`);
    assert.notEqual(codes[0], codes[1], `both orders were given the same pickup code ${codes[0]}`);
    assert.ok(codes.every((code) => /^\d{6}$/.test(code)));
    assert.ok(forcedCodeCalls >= 3, "the forced collision never happened, so the test proved nothing");

    // 2a. listDueActivities returns exactly the due ones (checked on this test's own activities).
    const now = new Date().toISOString();
    const due = (await repository.listDueActivities({ now, limit: 1000 })).map((activity) => activity.id);
    assert.ok(due.includes(activities.dueByEnd.id), "due by pickup end should be listed");
    assert.ok(due.includes(activities.dueByStart.id), "due by pickup start + 3 h should be listed");
    for (const key of ["notDue", "soonByStart", "soonByEnd", "codeA", "codeB"]) {
      assert.ok(!due.includes(activities[key].id), `${key} is not due and must not be listed`);
    }

    // 2b. claimPickupReminders claims exactly the activities closing within the lead time.
    const groups = await repository.claimPickupReminders({ now, leadMinutes: 30 });
    const remindedIds = groups.map((group) => group.activityId);
    assert.ok(remindedIds.includes(activities.soonByStart.id), "closing by start + 3 h should be reminded");
    assert.ok(remindedIds.includes(activities.soonByEnd.id), "closing by pickup end should be reminded");
    for (const key of ["notDue", "dueByEnd", "dueByStart"]) {
      assert.ok(!remindedIds.includes(activities[key].id), `${key} must not be reminded`);
    }
    const again = await repository.claimPickupReminders({ now, leadMinutes: 30 });
    assert.ok(!again.some((group) => [activities.soonByStart.id, activities.soonByEnd.id].includes(group.activityId)), "a second run must not remind the same orders again");

    console.log("PostgreSQL pickup concurrency proof passed: distinct codes under concurrency, scheduler pre-filters match the expiry rule.");
    void customerUserId;
  } finally {
    await cleanup(database);
    await database.close();
  }
}

// Without this the two transactions often run one after the other by chance, and the collision never shows. The
// barrier holds each transaction at "is this code already taken?" until the other one has arrived too (or 600 ms
// pass), so both checks happen before either insert -- exactly the window the old allocation was exposed in. With
// the advisory lock the second transaction cannot even reach that statement until the first has committed, so
// the barrier just times out for the first one.
function withCodeCheckBarrier(database, timeoutMs = 600) {
  let waiting = null;
  const arrive = () => new Promise((resolve) => {
    if (waiting) {
      const partner = waiting;
      waiting = null;
      partner.release();
      resolve();
      return;
    }
    const entry = { release: resolve };
    waiting = entry;
    setTimeout(() => {
      if (waiting === entry) waiting = null;
      resolve();
    }, timeoutMs);
  });
  return {
    ...database,
    transaction: (operation) => database.transaction((transaction) => operation({
      ...transaction,
      query: async (sql, parameters) => {
        if (/FROM pickup_credentials\s+WHERE pickup_code = \$1/.test(sql)) await arrive();
        return transaction.query(sql, parameters);
      },
    })),
  };
}

async function createFixture(database) {
  const merchant = (await database.query(
    "SELECT user_id FROM merchant_users WHERE store_id = 'store-001' AND status = 'active' LIMIT 1",
  )).rows[0];
  const customer = (await database.query(`
    SELECT user_account.id FROM users user_account
    JOIN user_roles user_role ON user_role.user_id = user_account.id
    WHERE user_role.role = 'customer' AND user_role.status = 'active' AND user_account.status = 'active'
    ORDER BY user_account.id LIMIT 1
  `)).rows[0];
  assert.ok(merchant && customer, "a store-001 merchant and an active customer are required");

  const nowMs = Date.now();
  await database.transaction(async (transaction) => {
    for (const activity of Object.values(activities)) {
      const pickupStart = new Date(nowMs + activity.pickupStartOffset).toISOString();
      const pickupEnd = new Date(nowMs + activity.pickupEndOffset).toISOString();
      const startAt = new Date(nowMs - 7 * HOUR).toISOString();
      const deadlineAt = new Date(nowMs - 6 * HOUR).toISOString();
      await transaction.query(`
        INSERT INTO group_buy_activities (
          id, store_id, created_by_user_id, title, status, start_at, deadline_at, pickup_start_at, pickup_end_at,
          maximum_cups, withdrawal_lock_minutes, created_at, updated_at
        ) VALUES ($1, 'store-001', $2, 'Pickup concurrency proof', $3, $4, $5, $6, $7, 2, 30, $4, $4)
      `, [activity.id, merchant.user_id, activity.status, startAt, deadlineAt, pickupStart, pickupEnd]);
      await transaction.query(`
        INSERT INTO orders (
          id, activity_id, customer_user_id, status, fallback_purchase_preference, total_cups, original_amount, final_amount,
          payment_status, authorization_status, merchant_acceptance_status, pickup_status, submitted_at, updated_at
        ) VALUES ($1, $2, $3, 'submitted', 'decline_original_price', 1, 60, 60, 'captured', 'captured', 'accepted', $4, $5, $5)
      `, [activity.orderId, activity.id, customer.id, activity.orderPickupStatus, new Date(nowMs).toISOString()]);
    }
  });
  return { merchantUserId: merchant.user_id, customerUserId: customer.id };
}

async function cleanup(database) {
  await database.transaction(async (transaction) => {
    await transaction.query("DELETE FROM pickup_credentials WHERE order_id = ANY($1::text[])", [orderIds]);
    await transaction.query(
      "DELETE FROM status_history WHERE resource_type IN ('activity', 'pickup', 'order') AND resource_id = ANY($1::text[])",
      [[...activityIds, ...orderIds]],
    );
    await transaction.query(
      "DELETE FROM audit_logs WHERE resource_type IN ('activity', 'order') AND resource_id = ANY($1::text[])",
      [[...activityIds, ...orderIds]],
    );
    await transaction.query("DELETE FROM orders WHERE id = ANY($1::text[])", [orderIds]);
    await transaction.query("DELETE FROM group_buy_activities WHERE id = ANY($1::text[])", [activityIds]);
    await transaction.query("DELETE FROM operation_locks WHERE lock_key LIKE '%' || $1 || '%'", [proofId]);
  });
  const residue = (await database.query(
    "SELECT (SELECT COUNT(*)::integer FROM group_buy_activities WHERE id = ANY($1::text[])) AS n", [activityIds],
  )).rows[0].n;
  assert.equal(residue, 0, "cleanup left activities behind");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
