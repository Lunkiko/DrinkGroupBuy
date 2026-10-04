"use strict";

const { randomInt, randomUUID } = require("node:crypto");
const { createRuntimeDatabaseAdapter } = require("..");
const { calculatePickupExpirationAt } = require("../../db");
const { getPostgresOrderDetail } = require("./customerOrderReadRepository");

function resolvePickupCredentialRuntime(input = {}) {
  const env = input.env || process.env;
  const runtime = String(input.runtime || env.PICKUP_CREDENTIAL_RUNTIME || "sqlite")
    .trim()
    .toLowerCase();
  if (runtime === "sqlite") return "sqlite";
  if (runtime === "postgres" || runtime === "postgresql") return "postgres";
  throw new Error(`Unsupported PICKUP_CREDENTIAL_RUNTIME: ${runtime}`);
}

function createPickupCredentialRepository(input = {}) {
  const runtime = resolvePickupCredentialRuntime(input);
  if (runtime === "sqlite") {
    const gateway = input.sqliteGateway || {};
    for (const name of [
      "markReady", "getCredentialForOrder", "lookupCode", "redeemCode",
      "listDueActivities", "expireWindow",
    ]) {
      if (typeof gateway[name] !== "function") {
        throw new Error(`${name} is required when PICKUP_CREDENTIAL_RUNTIME=sqlite`);
      }
    }
    return {
      kind: "sqlite",
      markReady: async (value) => gateway.markReady(value),
      getCredentialForOrder: async (value) => gateway.getCredentialForOrder(value),
      lookupCode: async (value) => gateway.lookupCode(value),
      redeemCode: async (value) => gateway.redeemCode(value),
      listDueActivities: async (value) => gateway.listDueActivities(value),
      expireWindow: async (value) => gateway.expireWindow(value),
      // Pickup reminders are Postgres-only (they need orders.pickup_reminder_sent_at, migration 010).
      claimPickupReminders: async () => [],
      close: async () => {},
    };
  }

  const ownsDatabase = !input.database;
  const database = input.database || createRuntimeDatabaseAdapter({ ...input, runtime: "postgres" });
  return {
    kind: "postgres",
    markReady: (value) => markReadyPostgres(database, value),
    getCredentialForOrder: (value) => getCredentialForOrderPostgres(database, value),
    lookupCode: (value) => lookupCodePostgres(database, value),
    redeemCode: (value) => redeemCodePostgres(database, value),
    listDueActivities: (value) => listDueActivitiesPostgres(database, value),
    expireWindow: (value) => expireWindowPostgres(database, value),
    claimPickupReminders: (value) => claimPickupRemindersPostgres(database, value),
    withOperationLock: (value, operation) => withPostgresPickupOperationLock(database, value, operation),
    close: async () => {
      if (ownsDatabase) await database.close();
    },
  };
}

async function withPostgresPickupOperationLock(database, input = {}, operation) {
  const lockKey = input.activityId
    ? `pickup:activity:${input.activityId}:transition`
    : `pickup:code:${input.pickupCode}:redeem`;
  const ownerId = `pickup-${process.pid}-${randomUUID()}`;
  const now = input.now || new Date().toISOString();
  const lockedUntil = new Date(Date.parse(now) + Number(input.leaseMs || 120_000)).toISOString();
  const result = await database.query(`
    INSERT INTO operation_locks (lock_key, owner_id, locked_until, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $4)
    ON CONFLICT (lock_key) DO UPDATE
    SET owner_id = EXCLUDED.owner_id,
        locked_until = EXCLUDED.locked_until,
        updated_at = EXCLUDED.updated_at
    WHERE operation_locks.locked_until <= $4
    RETURNING lock_key, owner_id, locked_until
  `, [lockKey, ownerId, lockedUntil, now]);
  if (!result.rows[0]) {
    const error = new Error("Pickup operation is already in progress");
    error.code = "operation_locked";
    error.lock = { lockKey };
    throw error;
  }
  try {
    return await operation();
  } finally {
    await database.query(`
      DELETE FROM operation_locks
      WHERE lock_key = $1 AND owner_id = $2
    `, [lockKey, ownerId]);
  }
}

async function markReadyPostgres(database, input = {}) {
  const activityId = input.activityId;
  const actorUserId = input.actorUserId || null;
  const now = input.now || new Date().toISOString();

  return database.transaction(async (transaction) => {
    const activityResult = await transaction.query(`
      SELECT
        activity.*,
        store.name AS store_name,
        EXISTS (
          SELECT 1
          FROM merchant_users merchant_user
          WHERE merchant_user.store_id = activity.store_id
            AND merchant_user.user_id = $1
            AND merchant_user.status = 'active'
        ) AS can_manage
      FROM group_buy_activities activity
      LEFT JOIN stores store ON store.id = activity.store_id
      WHERE activity.id = $2
      FOR UPDATE
    `, [actorUserId, activityId]);
    const activity = activityResult.rows[0];
    if (!activity) return { error: "activity_not_found" };
    if (!activity.can_manage) return { error: "activity_access_denied" };
    if (!["ordering", "ready_for_pickup"].includes(activity.status)) {
      return { error: "activity_not_readyable", activityStatus: activity.status };
    }

    const expiresAt = calculatePickupExpirationAt(activity.pickup_start_at, activity.pickup_end_at);
    if (!isBefore(now, expiresAt)) {
      return { error: "pickup_window_expired", expiresAt };
    }

    const ordersResult = await transaction.query(`
      SELECT id, pickup_status, customer_user_id
      FROM orders
      WHERE activity_id = $1
        AND ($2::text IS NULL OR id = $2)
        AND payment_status = 'captured'
        AND status != 'cancelled'
        AND pickup_status IN ('not_ready', 'ready')
      ORDER BY submitted_at ASC, id ASC
      FOR UPDATE
    `, [activityId, input.orderId ?? null]);
    const orders = ordersResult.rows;
    if (orders.length === 0) {
      return { error: "no_captured_orders" };
    }

    const activityUpdate = await transaction.query(`
      UPDATE group_buy_activities
      SET status = 'ready_for_pickup', updated_at = $1
      WHERE id = $2 AND status IN ('ordering', 'ready_for_pickup')
    `, [now, activityId]);
    if (activityUpdate.rowCount !== 1) {
      return { error: "activity_already_changed" };
    }

    if (activity.status !== "ready_for_pickup") {
      await insertStatusHistory(transaction, "activity", activityId, activity.status,
        "ready_for_pickup", "merchant_marked_ready_for_pickup", actorUserId, now);
    }

    const credentials = [];
    let createdCredentialCount = 0;
    let readyOrderCount = 0;
    // Only orders that just transitioned from not_ready -> ready belong here, not every order in
    // this batch -- a call that regenerates a credential for an already-ready order (see the
    // repeated-single-order branch below) must not re-notify a customer who was already told.
    const readyOrderCustomerUserIds = [];

    for (const order of orders) {
      const readyUpdate = await transaction.query(`
        UPDATE orders
        SET pickup_status = 'ready', updated_at = $1
        WHERE id = $2
          AND payment_status = 'captured'
          AND status != 'cancelled'
          AND pickup_status = 'not_ready'
      `, [now, order.id]);
      if (readyUpdate.rowCount === 1) {
        readyOrderCount += 1;
        readyOrderCustomerUserIds.push(order.customer_user_id);
        await insertStatusHistory(transaction, "pickup", order.id, order.pickup_status,
          "ready", "merchant_marked_ready_for_pickup", actorUserId, now);
      }

      let credential = (await transaction.query(
        "SELECT * FROM pickup_credentials WHERE order_id = $1", [order.id]
      )).rows[0];
      if (!credential) {
        const code = await generateAvailablePostgresCode(transaction);
        await transaction.query(`
          INSERT INTO pickup_credentials (
            id, order_id, pickup_code, visible_after_merchant_acceptance,
            expires_at, expired_at, redeemed_at, redeemed_by_user_id, created_at
          ) VALUES ($1, $2, $3, true, $4, NULL, NULL, NULL, $5)
        `, [`pickup-credential-${randomUUID()}`, order.id, code, expiresAt, now]);
        credential = (await transaction.query(
          "SELECT * FROM pickup_credentials WHERE order_id = $1", [order.id]
        )).rows[0];
        createdCredentialCount += 1;
      } else if (credential.redeemed_at || credential.expired_at) {
        throw new Error("Inactive pickup credential exists for order " + order.id);
      } else {
        await transaction.query(`
          UPDATE pickup_credentials
          SET expires_at = $1
          WHERE order_id = $2 AND redeemed_at IS NULL AND expired_at IS NULL
        `, [expiresAt, order.id]);
        credential = (await transaction.query(
          "SELECT * FROM pickup_credentials WHERE order_id = $1", [order.id]
        )).rows[0];
      }

      credentials.push(mapCredential(credential, {
        pickup_status: "ready",
        payment_status: "captured",
        activity_status: "ready_for_pickup"
      }, now));
    }

    if (activity.status !== "ready_for_pickup" || createdCredentialCount > 0 || readyOrderCount > 0) {
      await insertAudit(transaction, "merchant_mark_activity_ready_for_pickup", "activity", activityId,
        { createdCredentialCount, readyOrderCount, expiresAt, orderId: input.orderId ?? null }, actorUserId, now);
    }

    return {
      status: "ready_for_pickup",
      activityId,
      expiresAt,
      createdCredentialCount,
      readyOrderCount,
      credentials,
      readyOrderCustomerUserIds,
      storeName: activity.store_name
    };
  });
}

async function getCredentialForOrderPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const result = await database.query(`
    SELECT
      credential.*,
      orders.pickup_status,
      orders.payment_status,
      activity.status AS activity_status,
      store.id AS store_id,
      store.name AS store_name
    FROM pickup_credentials credential
    JOIN orders ON orders.id = credential.order_id
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    JOIN stores store ON store.id = activity.store_id
    WHERE credential.order_id = $1
  `, [input.orderId]);
  const row = result.rows[0];
  return row ? mapCredential(row, row, now) : null;
}

async function lookupCodePostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const row = await findMerchantCredentialPostgres(database, input.pickupCode, input.actorUserId);
  if (!row) return { error: "credential_not_found" };
  const order = await getPostgresOrderDetail(database, row.order_id);
  return { credential: mapMerchantCredential(row, now, order?.items) };
}

async function redeemCodePostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const actorUserId = input.actorUserId || null;

  const result = await database.transaction(async (transaction) => {
    const row = await findMerchantCredentialPostgres(transaction, input.pickupCode, actorUserId, true);
    if (!row) return { error: "credential_not_found" };

    const credential = mapMerchantCredential(row, now);
    const stateError = getRedemptionError(credential);
    if (stateError) return { error: stateError, credential };

    const credentialUpdate = await transaction.query(`
      UPDATE pickup_credentials
      SET redeemed_at = $1, redeemed_by_user_id = $2
      WHERE id = $3 AND redeemed_at IS NULL AND expired_at IS NULL
    `, [now, actorUserId, row.id]);
    if (credentialUpdate.rowCount !== 1) return { error: "credential_already_changed" };

    const orderUpdate = await transaction.query(`
      UPDATE orders
      SET status = 'completed', pickup_status = 'picked_up', updated_at = $1
      WHERE id = $2
        AND payment_status = 'captured'
        AND pickup_status = 'ready'
        AND status != 'cancelled'
    `, [now, row.order_id]);
    if (orderUpdate.rowCount !== 1) {
      throw new Error("Pickup order changed before redemption: " + row.order_id);
    }

    await insertStatusHistory(transaction, "pickup", row.order_id, row.pickup_status,
      "picked_up", "merchant_redeemed_pickup_code", actorUserId, now);
    if (row.order_status !== "completed") {
      await insertStatusHistory(transaction, "order", row.order_id, row.order_status,
        "completed", "merchant_redeemed_pickup_code", actorUserId, now);
    }

    const remaining = await transaction.query(`
      SELECT COUNT(*)::integer AS count
      FROM orders
      WHERE activity_id = $1
        AND payment_status = 'captured'
        AND status != 'cancelled'
        AND pickup_status IN ('not_ready', 'ready')
    `, [row.activity_id]);

    let activityCompleted = false;
    if (Number(remaining.rows[0].count) === 0) {
      const update = await transaction.query(`
        UPDATE group_buy_activities
        SET status = 'completed', updated_at = $1
        WHERE id = $2 AND status = 'ready_for_pickup'
      `, [now, row.activity_id]);
      if (update.rowCount === 1) {
        activityCompleted = true;
        await insertStatusHistory(transaction, "activity", row.activity_id, row.activity_status,
          "completed", "all_captured_orders_picked_up", actorUserId, now);
      }
    }

    await insertAudit(transaction, "merchant_redeem_pickup_code", "order", row.order_id,
      { pickupCredentialId: row.id, activityCompleted }, actorUserId, now);

    return {
      status: "redeemed",
      activityCompleted,
      orderId: row.order_id,
      credential: {
        ...credential,
        status: "redeemed",
        pickupStatus: "picked_up",
        orderStatus: "completed",
        redeemedAt: now
      }
    };
  });

  if (result.error) return result;

  // Fetched after the transaction commits, on the pooled (non-transactional) connection --
  // getPostgresOrderDetail runs several sub-queries concurrently via Promise.all, which a single
  // transactional connection can't safely support (pg logs a deprecation warning and the queries
  // silently serialize instead of actually running concurrently). Items are immutable snapshots
  // taken at order creation, so reading them after commit carries no staleness risk.
  const order = await getPostgresOrderDetail(database, result.orderId);
  result.credential.items = order?.items ?? [];
  delete result.orderId;
  return result;
}

async function findMerchantCredentialPostgres(database, pickupCode, actorUserId, lockRow = false) {
  const result = await database.query(`
    SELECT
      credential.*,
      orders.status AS order_status,
      orders.pickup_status,
      orders.payment_status,
      orders.total_cups,
      orders.final_amount,
      orders.activity_id,
      activity.status AS activity_status,
      activity.title AS activity_title,
      activity.pickup_start_at,
      activity.pickup_end_at,
      store.id AS store_id,
      store.name AS store_name,
      customer.display_name AS customer_display_name,
      customer.login_name AS customer_login_name
    FROM pickup_credentials credential
    JOIN orders ON orders.id = credential.order_id
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    JOIN stores store ON store.id = activity.store_id
    JOIN users customer ON customer.id = orders.customer_user_id
    JOIN merchant_users merchant_user ON merchant_user.store_id = store.id
    WHERE credential.pickup_code = $1
      AND merchant_user.user_id = $2
      AND merchant_user.status = 'active'
    ORDER BY
      CASE WHEN credential.redeemed_at IS NULL AND credential.expired_at IS NULL THEN 0 ELSE 1 END,
      credential.created_at DESC
    LIMIT 1
    ${lockRow ? "FOR UPDATE OF credential, orders" : ""}
  `, [pickupCode, actorUserId]);
  return result.rows[0] || null;
}

async function generateAvailablePostgresCode(transaction) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const exists = await transaction.query(`
      SELECT 1 FROM pickup_credentials
      WHERE pickup_code = $1 AND redeemed_at IS NULL AND expired_at IS NULL
      LIMIT 1
    `, [code]);
    if (!exists.rows[0]) return code;
  }
  throw new Error("Unable to allocate a unique pickup code");
}

async function listDueActivitiesPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const nowTime = Date.parse(now);
  const limit = normalizePositiveInteger(input.limit, 20);

  const result = await database.query(`
    SELECT id, status, pickup_start_at, pickup_end_at
    FROM group_buy_activities
    WHERE status IN ('ordering', 'ready_for_pickup')
    ORDER BY pickup_start_at ASC
  `);

  return result.rows
    .map((row) => {
      const expiresAt = calculatePickupExpirationAt(toIsoString(row.pickup_start_at), toIsoString(row.pickup_end_at));
      return {
        id: row.id,
        status: row.status,
        pickupStartAt: toIsoString(row.pickup_start_at),
        pickupEndAt: toIsoString(row.pickup_end_at),
        expiresAt,
        expiresTime: expiresAt ? Date.parse(expiresAt) : Number.NaN
      };
    })
    .filter((activity) => !Number.isNaN(nowTime)
      && !Number.isNaN(activity.expiresTime)
      && activity.expiresTime <= nowTime)
    .sort((left, right) => left.expiresTime - right.expiresTime)
    .slice(0, limit)
    .map(({ expiresTime, ...activity }) => activity);
}

// Claims, in one UPDATE, every ready-but-not-yet-picked-up order whose pickup window closes within
// `leadMinutes`, and returns them grouped by activity for the caller to notify. The claim
// (pickup_reminder_sent_at IS NULL -> now) is the dedup: two scheduler runs or two app instances can
// never both get the same order. The trade-off is at-most-once -- if the push call that follows fails,
// that order is not reminded again, which is acceptable for a convenience reminder.
async function claimPickupRemindersPostgres(database, input = {}) {
  const now = input.now || new Date().toISOString();
  const nowTime = Date.parse(now);
  const leadMs = normalizePositiveInteger(input.leadMinutes, 30) * 60_000;
  if (Number.isNaN(nowTime)) return [];

  const activitiesResult = await database.query(`
    SELECT activity.id, activity.title, activity.pickup_start_at, activity.pickup_end_at,
      store.name AS store_name
    FROM group_buy_activities activity
    JOIN stores store ON store.id = activity.store_id
    WHERE activity.status IN ('ordering', 'ready_for_pickup')
  `);
  const closingSoonByActivityId = new Map();
  for (const row of activitiesResult.rows) {
    const expiresAt = calculatePickupExpirationAt(toIsoString(row.pickup_start_at), toIsoString(row.pickup_end_at));
    const expiresTime = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (Number.isNaN(expiresTime) || expiresTime <= nowTime || expiresTime - nowTime > leadMs) continue;
    closingSoonByActivityId.set(row.id, { activityId: row.id, title: row.title, storeName: row.store_name, expiresAt });
  }
  if (closingSoonByActivityId.size === 0) return [];

  const claimed = await database.query(`
    UPDATE orders
    SET pickup_reminder_sent_at = $1
    WHERE activity_id = ANY($2::text[])
      AND status != 'cancelled'
      AND pickup_status = 'ready'
      AND pickup_reminder_sent_at IS NULL
    RETURNING id, activity_id, customer_user_id
  `, [now, [...closingSoonByActivityId.keys()]]);

  const groups = new Map();
  for (const row of claimed.rows) {
    const group = groups.get(row.activity_id)
      || { ...closingSoonByActivityId.get(row.activity_id), orderIds: [], customerUserIds: [] };
    group.orderIds.push(row.id);
    if (!group.customerUserIds.includes(row.customer_user_id)) group.customerUserIds.push(row.customer_user_id);
    groups.set(row.activity_id, group);
  }
  return [...groups.values()];
}

async function expireWindowPostgres(database, input = {}) {
  const activityId = input.activityId;
  const actorUserId = input.actorUserId || null;
  const now = input.now || new Date().toISOString();

  const preCheck = await database.query(`
    SELECT id, status, pickup_start_at, pickup_end_at
    FROM group_buy_activities
    WHERE id = $1
  `, [activityId]);
  const preActivity = preCheck.rows[0];
  if (!preActivity) return { status: "not_found", activityId };

  const expiresAt = calculatePickupExpirationAt(
    toIsoString(preActivity.pickup_start_at),
    toIsoString(preActivity.pickup_end_at)
  );
  const expiresTime = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const nowTime = Date.parse(now);
  if (Number.isNaN(expiresTime) || Number.isNaN(nowTime)) {
    return { status: "invalid_pickup_window", activityId, expiresAt };
  }
  if (nowTime < expiresTime) {
    return { status: "not_due", activityId, expiresAt };
  }
  if (preActivity.status === "completed") {
    return { status: "already_completed", activityId, expiresAt };
  }
  if (!["ordering", "ready_for_pickup"].includes(preActivity.status)) {
    return { status: "not_expirable", activityId, activityStatus: preActivity.status, expiresAt };
  }

  return database.transaction(async (transaction) => {
    const claimActivity = await transaction.query(`
      UPDATE group_buy_activities
      SET status = 'completed', updated_at = $1
      WHERE id = $2 AND status IN ('ordering', 'ready_for_pickup')
    `, [now, activityId]);
    if (claimActivity.rowCount !== 1) {
      return { status: "already_processed", activityId, expiresAt };
    }

    const ordersResult = await transaction.query(`
      SELECT id, status, payment_status, pickup_status
      FROM orders
      WHERE activity_id = $1
      ORDER BY submitted_at ASC, id ASC
      FOR UPDATE
    `, [activityId]);

    let expiredOrderCount = 0;
    let completedPickedUpOrderCount = 0;

    for (const order of ordersResult.rows) {
      if (order.payment_status === "captured"
        && ["not_ready", "ready"].includes(order.pickup_status)
        && order.status !== "cancelled") {
        const update = await transaction.query(`
          UPDATE orders
          SET status = 'completed', pickup_status = 'expired', updated_at = $1
          WHERE id = $2
            AND payment_status = 'captured'
            AND pickup_status IN ('not_ready', 'ready')
            AND status != 'cancelled'
        `, [now, order.id]);
        if (update.rowCount === 1) {
          expiredOrderCount += 1;
          await insertStatusHistory(transaction, "pickup", order.id, order.pickup_status,
            "expired", "pickup_window_expired", actorUserId, now);
          if (order.status !== "completed") {
            await insertStatusHistory(transaction, "order", order.id, order.status,
              "completed", "pickup_window_expired", actorUserId, now);
          }
        }
        continue;
      }

      if (order.payment_status === "captured"
        && order.pickup_status === "picked_up"
        && !["completed", "cancelled"].includes(order.status)) {
        const update = await transaction.query(`
          UPDATE orders
          SET status = 'completed', updated_at = $1
          WHERE id = $2
            AND payment_status = 'captured'
            AND pickup_status = 'picked_up'
            AND status != 'completed'
            AND status != 'cancelled'
        `, [now, order.id]);
        if (update.rowCount === 1) {
          completedPickedUpOrderCount += 1;
          await insertStatusHistory(transaction, "order", order.id, order.status,
            "completed", "pickup_completed_before_window_expired", actorUserId, now);
        }
      }
    }

    await transaction.query(`
      UPDATE pickup_credentials
      SET expires_at = COALESCE(expires_at, $1),
          expired_at = CASE
            WHEN order_id IN (
              SELECT id FROM orders WHERE activity_id = $2 AND pickup_status = 'expired'
            ) THEN COALESCE(expired_at, $3)
            ELSE expired_at
          END
      WHERE order_id IN (SELECT id FROM orders WHERE activity_id = $2)
    `, [expiresAt, activityId, now]);

    await insertStatusHistory(transaction, "activity", activityId, preActivity.status,
      "completed", "pickup_window_expired", actorUserId, now);
    await insertAudit(transaction, "system_expire_pickup_window", "activity", activityId,
      { expiresAt, expiredOrderCount, completedPickedUpOrderCount }, actorUserId, now);

    return {
      status: "completed",
      activityId,
      expiresAt,
      expiredOrderCount,
      completedPickedUpOrderCount
    };
  });
}

async function insertStatusHistory(database, resourceType, resourceId, fromStatus, toStatus, reason, actorUserId, now) {
  await database.query(`
    INSERT INTO status_history (
      id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [`status-history-${randomUUID()}`, resourceType, resourceId, fromStatus, toStatus, reason, actorUserId, now]);
}

async function insertAudit(database, actionType, resourceType, resourceId, metadata, actorUserId, now) {
  await database.query(`
    INSERT INTO audit_logs (
      id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
  `, [`audit-log-${randomUUID()}`, actorUserId, actionType, resourceType, resourceId, JSON.stringify(metadata), now]);
}

function mapCredential(row, context, now) {
  const status = getCredentialStatus({ ...row, ...context }, now);
  return {
    id: row.id,
    orderId: row.order_id,
    pickupCode: status === "active" ? row.pickup_code : null,
    status,
    pickupStatus: context.pickup_status,
    expiresAt: toIsoString(row.expires_at),
    expiredAt: toIsoString(row.expired_at),
    redeemedAt: toIsoString(row.redeemed_at),
    createdAt: toIsoString(row.created_at),
    store: row.store_id ? { id: row.store_id, name: row.store_name } : null
  };
}

function mapMerchantCredential(row, now, items = []) {
  return {
    ...mapCredential(row, row, now),
    pickupCode: row.pickup_code,
    orderStatus: row.order_status,
    paymentStatus: row.payment_status,
    totalCups: row.total_cups,
    finalAmount: row.final_amount,
    activity: {
      id: row.activity_id,
      title: row.activity_title,
      status: row.activity_status,
      pickupStartAt: toIsoString(row.pickup_start_at),
      pickupEndAt: toIsoString(row.pickup_end_at)
    },
    customerDisplayName: row.customer_display_name || row.customer_login_name || null,
    items
  };
}

function getCredentialStatus(row, now) {
  if (row.redeemed_at || row.pickup_status === "picked_up") return "redeemed";
  if (row.expired_at || row.pickup_status === "expired" || !isBefore(now, toIsoString(row.expires_at))) {
    return "expired";
  }
  if (row.payment_status === "captured"
    && row.pickup_status === "ready"
    && row.activity_status === "ready_for_pickup") {
    return "active";
  }
  return "unavailable";
}

function getRedemptionError(credential) {
  if (credential.status === "redeemed") return "credential_already_redeemed";
  if (credential.status === "expired") return "credential_expired";
  if (credential.status !== "active") return "order_not_ready_for_pickup";
  return null;
}

function isBefore(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return !Number.isNaN(leftTime) && !Number.isNaN(rightTime) && leftTime < rightTime;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : value;
}

module.exports = {
  createPickupCredentialRepository,
  resolvePickupCredentialRuntime,
};
