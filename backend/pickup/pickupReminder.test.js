"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPickupCredentialRepository } = require("../database/repositories/pickupCredentialRepository");
const { buildPickupReminderNotification, runDuePickupReminders } = require("./expirationService");

// Window is pickup_start 11:00Z + 3h = expires 14:00Z (22:00 Taipei).
const ACTIVITY_ROW = {
  id: "activity-a",
  title: "手搖飲團購",
  store_name: "青山手作茶 中科店",
  pickup_start_at: "2026-10-04T11:00:00.000Z",
  pickup_end_at: "2026-10-04T14:00:00.000Z"
};

function fixture({ claimedRows = [], activities = [ACTIVITY_ROW] } = {}) {
  const calls = [];
  const database = {
    async query(sql, params) {
      sql = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      if (sql.startsWith("SELECT activity.id")) return { rows: activities };
      if (sql.startsWith("UPDATE orders")) return { rows: claimedRows };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return { calls, repository: createPickupCredentialRepository({ runtime: "postgres", database }) };
}

test("claimPickupReminders claims only ready, unreminded, uncancelled orders in one UPDATE", async () => {
  const { repository, calls } = fixture({
    claimedRows: [
      { id: "order-1", activity_id: "activity-a", customer_user_id: "user-1" },
      { id: "order-2", activity_id: "activity-a", customer_user_id: "user-1" },
      { id: "order-3", activity_id: "activity-a", customer_user_id: "user-2" }
    ]
  });

  const groups = await repository.claimPickupReminders({ now: "2026-10-04T13:40:00.000Z", leadMinutes: 30 });

  const update = calls.find((call) => call.sql.startsWith("UPDATE orders"));
  assert.match(update.sql, /pickup_reminder_sent_at IS NULL/);
  assert.match(update.sql, /pickup_status = 'ready'/);
  assert.match(update.sql, /status != 'cancelled'/);
  assert.match(update.sql, /RETURNING id, activity_id, customer_user_id/);
  assert.deepEqual(update.params, ["2026-10-04T13:40:00.000Z", ["activity-a"]]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].orderIds, ["order-1", "order-2", "order-3"]);
  assert.deepEqual(groups[0].customerUserIds, ["user-1", "user-2"]);
  assert.equal(groups[0].storeName, "青山手作茶 中科店");
  assert.equal(groups[0].expiresAt, "2026-10-04T14:00:00.000Z");
});

test("claimPickupReminders does nothing outside the lead window or after the window closed", async () => {
  for (const now of ["2026-10-04T13:20:00.000Z", "2026-10-04T14:00:00.000Z", "2026-10-04T15:00:00.000Z"]) {
    const { repository, calls } = fixture({
      claimedRows: [{ id: "order-1", activity_id: "activity-a", customer_user_id: "user-1" }]
    });

    const groups = await repository.claimPickupReminders({ now, leadMinutes: 30 });

    assert.deepEqual(groups, [], `now=${now}`);
    assert.ok(!calls.some((call) => call.sql.startsWith("UPDATE orders")), `no claim at now=${now}`);
  }
});

test("claimPickupReminders returns no group for an activity whose orders were all already reminded", async () => {
  const { repository } = fixture({ claimedRows: [] });

  const groups = await repository.claimPickupReminders({ now: "2026-10-04T13:40:00.000Z", leadMinutes: 30 });

  assert.deepEqual(groups, []);
});

test("buildPickupReminderNotification shows the closing time in Taipei time", () => {
  const notification = buildPickupReminderNotification({
    activityId: "activity-a",
    storeName: "青山手作茶 中科店",
    expiresAt: "2026-10-04T14:00:00.000Z",
    customerUserIds: ["user-1"]
  });

  assert.deepEqual(notification.userIds, ["user-1"]);
  assert.equal(notification.title, "取餐時間快結束了");
  assert.match(notification.body, /青山手作茶 中科店/);
  assert.match(notification.body, /22:00/);
  assert.deepEqual(notification.data, { type: "pickup_closing_soon", activityId: "activity-a" });
});

test("runDuePickupReminders sends one push per activity group", async (t) => {
  const fetchCalls = [];
  t.mock.method(global, "fetch", async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: true, status: 200 };
  });
  const { repository } = fixture({
    claimedRows: [{ id: "order-1", activity_id: "activity-a", customer_user_id: "user-1" }]
  });

  const summary = await runDuePickupReminders({
    now: "2026-10-04T13:40:00.000Z",
    pickupCredentialRepository: repository,
    pushTokenRepository: { getPushTokensForUsers: async () => ["token-1"] },
    logger: { error() {} }
  });

  assert.deepEqual(summary, { reminderGroupCount: 1, reminderOrderCount: 1 });
  assert.equal(fetchCalls.length, 1);
  assert.equal(JSON.parse(fetchCalls[0].options.body)[0].data.type, "pickup_closing_soon");
});

test("runDuePickupReminders is a no-op when disabled, not Postgres, or push is not wired", async () => {
  const pg = fixture().repository;
  const sqlite = { kind: "sqlite", claimPickupReminders: async () => { throw new Error("must not run"); } };
  const push = { getPushTokensForUsers: async () => [] };
  const empty = { reminderGroupCount: 0, reminderOrderCount: 0 };

  assert.deepEqual(await runDuePickupReminders({ pickupCredentialRepository: pg, pushTokenRepository: push, leadMinutes: 0 }), empty);
  assert.deepEqual(await runDuePickupReminders({ pickupCredentialRepository: sqlite, pushTokenRepository: push }), empty);
  assert.deepEqual(await runDuePickupReminders({ pickupCredentialRepository: pg }), empty);
});

test("runDuePickupReminders swallows a repository failure instead of throwing", async () => {
  const broken = { kind: "postgres", claimPickupReminders: async () => { throw new Error("column does not exist"); } };

  const summary = await runDuePickupReminders({
    pickupCredentialRepository: broken,
    pushTokenRepository: { getPushTokensForUsers: async () => [] },
    logger: { error() {} }
  });

  assert.equal(summary.error, "column does not exist");
  assert.equal(summary.reminderOrderCount, 0);
});
