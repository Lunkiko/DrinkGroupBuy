"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPickupCredentialRepository } = require("./pickupCredentialRepository");

// A database that only knows how to take and release the operation lock row.
function createFakeLockDatabase() {
  const calls = { acquired: 0, released: 0 };
  return {
    calls,
    kind: "postgres",
    async query(sql) {
      if (sql.includes("INSERT INTO operation_locks")) {
        calls.acquired += 1;
        return { rows: [{ lock_key: "lock", owner_id: "owner", locked_until: "later" }] };
      }
      if (sql.includes("DELETE FROM operation_locks")) {
        calls.released += 1;
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async close() {},
  };
}

function deadlockError() {
  return Object.assign(new Error("deadlock detected"), { code: "40P01" });
}

test("a deadlock aborts the transaction once, then the whole operation runs again and succeeds", async () => {
  const database = createFakeLockDatabase();
  const repository = createPickupCredentialRepository({ runtime: "postgres", database });
  let attempts = 0;

  const result = await repository.withOperationLock({ activityId: "activity-1" }, async () => {
    attempts += 1;
    if (attempts === 1) throw deadlockError();
    return "done";
  });

  assert.equal(result, "done");
  assert.equal(attempts, 2);
  assert.equal(database.calls.acquired, 1, "the operation lock is taken once, not once per attempt");
  assert.equal(database.calls.released, 1, "and released exactly once");
});

test("gives up and reports the deadlock after three attempts, still releasing the lock", async () => {
  const database = createFakeLockDatabase();
  const repository = createPickupCredentialRepository({ runtime: "postgres", database });
  let attempts = 0;

  await assert.rejects(
    repository.withOperationLock({ activityId: "activity-1" }, async () => {
      attempts += 1;
      throw deadlockError();
    }),
    (error) => error.code === "40P01",
  );

  assert.equal(attempts, 3);
  assert.equal(database.calls.released, 1);
});

test("other errors are never retried", async () => {
  const database = createFakeLockDatabase();
  const repository = createPickupCredentialRepository({ runtime: "postgres", database });
  let attempts = 0;

  await assert.rejects(
    repository.withOperationLock({ pickupCode: "123456" }, async () => {
      attempts += 1;
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }),
    (error) => error.code === "23505",
  );

  assert.equal(attempts, 1);
  assert.equal(database.calls.released, 1);
});
