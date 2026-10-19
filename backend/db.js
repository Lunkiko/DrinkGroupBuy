const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const {
  calculatePercentageDiscount,
  resolveAppliedDiscountTier,
  validateDiscountTierConfiguration
} = require("./pricing/groupBuyDiscount");
const {
  getStoreDiscountPricingContext
} = require("./pricing/groupBuyDiscountDatabase");
const {
  validatePickupWindowAgainstClosingTime,
  validateDeadlineAgainstClosingTime,
} = require("./pickup/pickupWindow");

const databasePath = process.env.DRINK_GROUP_BUY_DB_PATH
  ? path.resolve(process.env.DRINK_GROUP_BUY_DB_PATH)
  : path.join(__dirname, "..", "database", "drink-group-buy-dev.sqlite");

function openDatabase() {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  ensureRuntimeSchema(database);
  return database;
}

function ensureRuntimeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS order_rule_consents (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      customer_user_id TEXT NOT NULL REFERENCES users(id),
      rule_type TEXT NOT NULL CHECK (rule_type IN ('pickup_overdue')),
      rule_version TEXT NOT NULL,
      rule_content_snapshot TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      UNIQUE (order_id, rule_type, rule_version)
    );

    CREATE INDEX IF NOT EXISTS idx_order_rule_consents_order
    ON order_rule_consents(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_rule_consents_customer
    ON order_rule_consents(customer_user_id);
    CREATE INDEX IF NOT EXISTS idx_order_rule_consents_consented_at
    ON order_rule_consents(consented_at);
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS order_action_idempotency (
      idempotency_key TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      action_type TEXT NOT NULL,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_active_per_customer_activity
    ON orders(activity_id, customer_user_id)
    WHERE status != 'cancelled';
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS menu_item_customization_rules (
      menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
      min_selections INTEGER NOT NULL DEFAULT 0 CHECK (min_selections >= 0),
      max_selections INTEGER NOT NULL CHECK (max_selections >= min_selections),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (menu_item_id, option_type)
    );
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS order_revisions (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending_authorization'
        CHECK (status IN ('pending_authorization', 'applied', 'failed', 'cancelled')),
      original_payment_authorization_id TEXT REFERENCES payment_authorizations(id),
      replacement_payment_authorization_id TEXT REFERENCES payment_authorizations(id),
      fallback_purchase_preference TEXT NOT NULL DEFAULT 'decline_original_price'
        CHECK (fallback_purchase_preference IN ('decline_original_price', 'accept_original_price')),
      previous_total_cups INTEGER NOT NULL CHECK (previous_total_cups > 0),
      previous_original_amount INTEGER NOT NULL CHECK (previous_original_amount >= 0),
      total_cups INTEGER NOT NULL CHECK (total_cups > 0),
      original_amount INTEGER NOT NULL CHECK (original_amount >= 0),
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      applied_at TEXT,
      cancelled_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_order_revisions_order ON order_revisions(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_revisions_status ON order_revisions(status);

    CREATE TABLE IF NOT EXISTS order_revision_items (
      id TEXT PRIMARY KEY,
      order_revision_id TEXT NOT NULL REFERENCES order_revisions(id) ON DELETE CASCADE,
      menu_item_id TEXT REFERENCES menu_items(id),
      item_name_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot >= 0),
      subtotal INTEGER NOT NULL CHECK (subtotal >= 0)
    );

    CREATE TABLE IF NOT EXISTS order_revision_item_customizations (
      id TEXT PRIMARY KEY,
      order_revision_item_id TEXT NOT NULL REFERENCES order_revision_items(id) ON DELETE CASCADE,
      customization_option_id TEXT REFERENCES customization_options(id),
      option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
      label_snapshot TEXT NOT NULL,
      price_delta_snapshot INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);

  const paymentAuthorizationColumns = database.prepare("PRAGMA table_info(payment_authorizations)").all();
  const hasOrderRevisionId = paymentAuthorizationColumns.some((column) => column.name === "order_revision_id");
  if (!hasOrderRevisionId) {
    database.exec("ALTER TABLE payment_authorizations ADD COLUMN order_revision_id TEXT REFERENCES order_revisions(id);");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_payment_authorizations_order_revision
    ON payment_authorizations(order_revision_id);
  `);

  const paymentCaptureColumns = database.prepare("PRAGMA table_info(payment_captures)").all();
  if (!paymentCaptureColumns.some((column) => column.name === "attempt_number")) {
    database.exec("ALTER TABLE payment_captures ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 1;");
  }
  if (!paymentCaptureColumns.some((column) => column.name === "retryable")) {
    database.exec("ALTER TABLE payment_captures ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0;");
  }
  if (!paymentCaptureColumns.some((column) => column.name === "next_retry_at")) {
    database.exec("ALTER TABLE payment_captures ADD COLUMN next_retry_at TEXT;");
  }
  if (!paymentAuthorizationColumns.some((column) => column.name === "payment_flow")) {
    database.exec("ALTER TABLE payment_authorizations ADD COLUMN payment_flow TEXT NOT NULL DEFAULT 'authorization';");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_payment_captures_authorization_attempt
    ON payment_captures(payment_authorization_id, attempt_number);
  `);

  const pickupCredentialColumns = database.prepare("PRAGMA table_info(pickup_credentials)").all();
  if (!pickupCredentialColumns.some((column) => column.name === "expires_at")) {
    database.exec("ALTER TABLE pickup_credentials ADD COLUMN expires_at TEXT;");
  }
  if (!pickupCredentialColumns.some((column) => column.name === "expired_at")) {
    database.exec("ALTER TABLE pickup_credentials ADD COLUMN expired_at TEXT;");
  }
  if (!pickupCredentialColumns.some((column) => column.name === "redeemed_at")) {
    database.exec("ALTER TABLE pickup_credentials ADD COLUMN redeemed_at TEXT;");
  }
  if (!pickupCredentialColumns.some((column) => column.name === "redeemed_by_user_id")) {
    database.exec("ALTER TABLE pickup_credentials ADD COLUMN redeemed_by_user_id TEXT REFERENCES users(id);");
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_pickup_credentials_expires_at
    ON pickup_credentials(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pickup_credentials_active_code
    ON pickup_credentials(pickup_code)
    WHERE redeemed_at IS NULL AND expired_at IS NULL;
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS payment_refunds (
      id TEXT PRIMARY KEY,
      payment_capture_id TEXT NOT NULL REFERENCES payment_captures(id),
      payment_authorization_id TEXT NOT NULL REFERENCES payment_authorizations(id),
      order_id TEXT NOT NULL REFERENCES orders(id),
      provider TEXT NOT NULL CHECK (provider IN ('line_pay', 'mock_line_pay')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'refunded', 'failed')),
      refund_amount INTEGER NOT NULL CHECK (refund_amount > 0),
      provider_refund_id TEXT,
      idempotency_key TEXT UNIQUE,
      refunded_at TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_payment_refunds_capture ON payment_refunds(payment_capture_id);
    CREATE INDEX IF NOT EXISTS idx_payment_refunds_order ON payment_refunds(order_id);
  `);

  addCustomizationOptionPriceDeltaCheckConstraint(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS refund_requests (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id),
      payment_capture_id TEXT NOT NULL REFERENCES payment_captures(id),
      store_id TEXT NOT NULL REFERENCES stores(id),
      requested_by_user_id TEXT NOT NULL REFERENCES users(id),
      requested_amount INTEGER NOT NULL CHECK (requested_amount > 0),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
      idempotency_key TEXT UNIQUE,
      reviewed_by_user_id TEXT REFERENCES users(id),
      reviewed_at TEXT,
      rejection_reason TEXT,
      resulting_payment_refund_id TEXT REFERENCES payment_refunds(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_refund_requests_store ON refund_requests(store_id, status);
    CREATE INDEX IF NOT EXISTS idx_refund_requests_order ON refund_requests(order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_requests_pending_per_capture
    ON refund_requests(payment_capture_id)
    WHERE status = 'pending';
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS payment_reliability_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL CHECK (job_type IN ('reconcile_line_pay_request', 'settle_group_buy_activity')),
      resource_type TEXT NOT NULL CHECK (resource_type IN ('payment_authorization', 'activity')),
      resource_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      max_attempts INTEGER NOT NULL DEFAULT 20 CHECK (max_attempts > 0),
      run_after TEXT NOT NULL,
      locked_by TEXT,
      locked_until TEXT,
      last_error_json TEXT,
      alert_required INTEGER NOT NULL DEFAULT 0 CHECK (alert_required IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_reliability_jobs_active_resource
    ON payment_reliability_jobs(job_type, resource_type, resource_id)
    WHERE status IN ('queued', 'running', 'retry_wait');

    CREATE INDEX IF NOT EXISTS idx_payment_reliability_jobs_due
    ON payment_reliability_jobs(job_type, status, run_after, locked_until);

    CREATE TABLE IF NOT EXISTS operation_locks (
      lock_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      locked_until TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_operation_locks_expiry
    ON operation_locks(locked_until);
  `);
}

// SQLite CHECK constraints cannot be altered in place; adding the non-negative
// guard requires rebuilding the table (https://www.sqlite.org/lang_altertable.html #6).
function addCustomizationOptionPriceDeltaCheckConstraint(database) {
  const table = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customization_options'"
  ).get();
  if (!table || table.sql.includes("price_delta >= 0")) return;

  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec("BEGIN;");
    try {
      database.exec(`
        CREATE TABLE customization_options_new (
          id TEXT PRIMARY KEY,
          menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
          option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
          label TEXT NOT NULL,
          price_delta INTEGER NOT NULL DEFAULT 0 CHECK (price_delta >= 0),
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1))
        );

        INSERT INTO customization_options_new (
          id, menu_item_id, option_type, label, price_delta, sort_order, is_available
        )
        SELECT id, menu_item_id, option_type, label, price_delta, sort_order, is_available
        FROM customization_options;

        DROP TABLE customization_options;
        ALTER TABLE customization_options_new RENAME TO customization_options;
      `);

      const fkViolations = database.prepare("PRAGMA foreign_key_check;").all();
      if (fkViolations.length > 0) {
        throw new Error(`customization_options price_delta CHECK migration produced foreign key violations: ${JSON.stringify(fkViolations)}`);
      }

      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  } finally {
    database.exec("PRAGMA foreign_keys = ON;");
  }
}

function listGroupBuyActivities() {
  const database = openDatabase();
  try {
    const rows = database.prepare(`
      SELECT
        activity.id,
        activity.store_id,
        activity.created_by_user_id,
        activity.title,
        activity.status,
        activity.start_at,
        activity.deadline_at,
        activity.pickup_start_at,
        activity.pickup_end_at,
        activity.maximum_cups,
        activity.withdrawal_lock_minutes,
        activity.cancellation_reason,
        store.name AS store_name,
        store.address AS store_address,
        store.phone AS store_phone,
        store.latitude,
        store.longitude
      FROM group_buy_activities activity
      JOIN stores store ON store.id = activity.store_id
      ORDER BY activity.created_at DESC
    `).all();

    const tiers = database.prepare(`
      SELECT id, activity_id, target_cups, discount_percent, sort_order
      FROM promotion_tiers
      ORDER BY target_cups ASC
    `).all();
    const progressRows = database.prepare(`
      SELECT
        activity_id,
        COALESCE(SUM(total_cups), 0) AS authorized_cups,
        COUNT(*) AS participant_count
      FROM orders
      WHERE payment_status IN ('authorized', 'captured')
        AND status NOT IN ('cancelled')
      GROUP BY activity_id
    `).all();
    const progressByActivityId = new Map(progressRows.map((row) => [row.activity_id, row]));
    const settlementRows = database.prepare(`
      SELECT *
      FROM activity_settlements
    `).all();
    const settlementByActivityId = new Map(
      settlementRows.map((row) => [row.activity_id, mapActivitySettlement(row)])
    );

    return rows.map((row) => {
      const activityTiers = tiers
        .filter((tier) => tier.activity_id === row.id)
        .map((tier) => ({
          id: tier.id,
          targetCups: tier.target_cups,
          cups: tier.target_cups,
          discountPercent: tier.discount_percent,
          sortOrder: tier.sort_order
        }));
      const progress = progressByActivityId.get(row.id);
      const authorizedCups = Number(progress?.authorized_cups ?? 0);
      const participantCount = Number(progress?.participant_count ?? 0);
      const discountSummary = resolveAppliedDiscountTier(activityTiers, authorizedCups);
      const firstTargetCups = activityTiers[0]?.targetCups ?? row.maximum_cups ?? 0;
      const displayStatus = row.status === "recruiting" && authorizedCups >= firstTargetCups
        ? "confirmed"
        : row.status;

      return {
        id: row.id,
        storeId: row.store_id,
        title: row.title,
        status: displayStatus,
        rawStatus: row.status,
        startAt: row.start_at,
        deadlineAt: row.deadline_at,
        pickupStartAt: row.pickup_start_at,
        pickupEndAt: row.pickup_end_at,
        maximumCups: row.maximum_cups,
        targetCups: firstTargetCups,
        currentCups: authorizedCups,
        authorizedCups,
        participantCount,
        ...discountSummary,
        settlement: settlementByActivityId.get(row.id) ?? null,
        withdrawalLockMinutes: row.withdrawal_lock_minutes,
        cancellationReason: row.cancellation_reason,
        store: {
          name: row.store_name,
          address: row.store_address,
          phone: row.store_phone,
          latitude: row.latitude,
          longitude: row.longitude
        },
        tiers: activityTiers
      };
    });
  } finally {
    database.close();
  }
}

function listPublicStores() {
  const database = openDatabase();
  try {
    return database.prepare(`
      SELECT
        id,
        name,
        address,
        phone,
        business_status,
        latitude,
        longitude
      FROM stores
      WHERE business_status = 'open'
        AND latitude IS NOT NULL
        AND longitude IS NOT NULL
      ORDER BY id ASC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      phone: row.phone,
      businessStatus: row.business_status,
      latitude: row.latitude,
      longitude: row.longitude
    }));
  } finally {
    database.close();
  }
}

function createGroupBuyActivity(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const activityId = `activity-${randomUUID()}`;
  let tiers = normalizeTiers(input.tiers);
  const idempotencyKey = input.idempotencyKey || null;
  let transactionStarted = false;

  try {
    if (idempotencyKey) {
      const existingLog = database.prepare(`
        SELECT resource_id
        FROM audit_logs
        WHERE action_type = 'merchant_create_group_buy_activity'
          AND json_extract(metadata_json, '$.idempotencyKey') = ?
        ORDER BY created_at DESC
        LIMIT 1
      `).get(idempotencyKey);

      if (existingLog?.resource_id) {
        return listGroupBuyActivities().find((activity) => activity.id === existingLog.resource_id);
      }
    }

    const storeRow = database.prepare(`
      SELECT pickup_closing_time FROM stores WHERE id = ?
    `).get(input.storeId);
    const pickupWindowError = validatePickupWindowAgainstClosingTime(
      input.pickupStartAt,
      storeRow?.pickup_closing_time
    );
    if (pickupWindowError) return { ...pickupWindowError, storeId: input.storeId };

    const deadlineClosingError = validateDeadlineAgainstClosingTime(
      input.deadlineAt,
      storeRow?.pickup_closing_time
    );
    if (deadlineClosingError) return { ...deadlineClosingError, storeId: input.storeId };

    const menuPricing = getStoreDiscountPricingContext(database, input.storeId);
    if (menuPricing.error || menuPricing.menuItemCount === 0) {
      return {
        error: "discount_menu_invalid",
        reason: menuPricing.error || "store_menu_empty",
        storeId: input.storeId
      };
    }
    const tierValidation = validateDiscountTierConfiguration({
      tiers,
      maximumCups: tiers.at(-1)?.targetCups
    });
    if (!tierValidation.valid) return tierValidation;
    tiers = tierValidation.tiers;

    database.exec("BEGIN;");
    transactionStarted = true;
    database.prepare(`
      INSERT INTO group_buy_activities (
        id,
        store_id,
        created_by_user_id,
        title,
        status,
        start_at,
        deadline_at,
        pickup_start_at,
        pickup_end_at,
        maximum_cups,
        withdrawal_lock_minutes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'recruiting', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      activityId,
      input.storeId,
      input.createdByUserId,
      input.title,
      input.startAt,
      input.deadlineAt,
      input.pickupStartAt,
      input.pickupEndAt,
      tiers[tiers.length - 1].targetCups,
      input.withdrawalLockMinutes ?? 30,
      now,
      now
    );

    const insertTier = database.prepare(`
      INSERT INTO promotion_tiers (
        id,
        activity_id,
        target_cups,
        discount_percent,
        sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `);

    tiers.forEach((tier, index) => {
      insertTier.run(
        `tier-${randomUUID()}`,
        activityId,
        tier.targetCups,
        tier.discountPercent,
        index
      );
    });

    if (input.notice) {
      database.prepare(`
        INSERT INTO activity_notices (id, activity_id, content, sort_order)
        VALUES (?, ?, ?, 0)
      `).run(`notice-${randomUUID()}`, activityId, input.notice);
    }

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, 'merchant_create_group_buy_activity', 'activity', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.createdByUserId,
      activityId,
      JSON.stringify({
        idempotencyKey,
        discountRanges: tierValidation.ranges
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;
    return listGroupBuyActivities().find((activity) => activity.id === activityId);
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function cancelGroupBuyActivity(activityId, input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const reason = input.reason || "Deleted by admin prototype action.";
  const requestedActorUserId = input.actorUserId || null;
  const actionType = input.actionType || "admin_cancel_group_buy_activity";
  let transactionStarted = false;

  try {
    const activity = database.prepare(`
      SELECT id, status
      FROM group_buy_activities
      WHERE id = ?
    `).get(activityId);

    if (!activity) {
      return null;
    }

    if (activity.status === "cancelled") {
      return listGroupBuyActivities().find((item) => item.id === activityId);
    }

    const actor = requestedActorUserId
      ? database.prepare("SELECT id FROM users WHERE id = ?").get(requestedActorUserId)
      : null;
    const actorUserId = actor?.id ?? null;

    database.exec("BEGIN;");
    transactionStarted = true;
    database.prepare(`
      UPDATE group_buy_activities
      SET status = 'cancelled',
          cancellation_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(reason, now, activityId);

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'activity', ?, ?, 'cancelled', ?, ?, ?)
    `).run(
      `status-history-${randomUUID()}`,
      activityId,
      activity.status,
      reason,
      actorUserId,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, ?, 'activity', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      actorUserId,
      actionType,
      activityId,
      JSON.stringify({ reason }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;
    return listGroupBuyActivities().find((item) => item.id === activityId);
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function listDueGroupBuyActivitiesForSettlement(input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const nowTime = Date.parse(now);
  const limit = normalizePositiveInteger(input.limit, 20);

  try {
    const rows = database.prepare(`
      SELECT
        activity.id,
        activity.status,
        activity.deadline_at
      FROM group_buy_activities activity
      LEFT JOIN activity_settlements settlement
        ON settlement.activity_id = activity.id
      WHERE settlement.id IS NULL
        AND activity.status IN ('recruiting', 'confirmed', 'ordering')
      ORDER BY activity.deadline_at ASC
    `).all();

    return rows
      .map((row) => ({
        id: row.id,
        status: row.status,
        deadlineAt: row.deadline_at,
        deadlineTime: Date.parse(row.deadline_at)
      }))
      .filter((activity) => !Number.isNaN(nowTime)
        && !Number.isNaN(activity.deadlineTime)
        && activity.deadlineTime <= nowTime)
      .sort((left, right) => left.deadlineTime - right.deadlineTime)
      .slice(0, limit)
      .map(({ deadlineTime, ...activity }) => activity);
  } finally {
    database.close();
  }
}

function listDueGroupBuyActivitiesForPickupExpiration(input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const nowTime = Date.parse(now);
  const limit = normalizePositiveInteger(input.limit, 20);

  try {
    const rows = database.prepare(`
      SELECT id, status, pickup_start_at, pickup_end_at
      FROM group_buy_activities
      WHERE status IN ('ordering', 'ready_for_pickup')
      ORDER BY pickup_start_at ASC
    `).all();

    return rows
      .map((row) => {
        const expiresAt = calculatePickupExpirationAt(row.pickup_start_at, row.pickup_end_at);
        return {
          id: row.id,
          status: row.status,
          pickupStartAt: row.pickup_start_at,
          pickupEndAt: row.pickup_end_at,
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
  } finally {
    database.close();
  }
}

function applyPickupWindowExpirationToOrder(order, { expireOrder, completePickedUpOrder, insertHistory, now, actorUserId }) {
  if (order.payment_status === "captured"
    && ["not_ready", "ready"].includes(order.pickup_status)
    && order.status !== "cancelled") {
    const update = expireOrder.run(now, order.id);
    if (update.changes !== 1) {
      return { expired: false, completedPickedUp: false };
    }
    insertHistory.run(
      `status-history-${randomUUID()}`,
      "pickup",
      order.id,
      order.pickup_status,
      "expired",
      "pickup_window_expired",
      actorUserId,
      now
    );
    if (order.status !== "completed") {
      insertHistory.run(
        `status-history-${randomUUID()}`,
        "order",
        order.id,
        order.status,
        "completed",
        "pickup_window_expired",
        actorUserId,
        now
      );
    }
    return { expired: true, completedPickedUp: false };
  }

  if (order.payment_status === "captured"
    && order.pickup_status === "picked_up"
    && !["completed", "cancelled"].includes(order.status)) {
    const update = completePickedUpOrder.run(now, order.id);
    if (update.changes !== 1) {
      return { expired: false, completedPickedUp: false };
    }
    insertHistory.run(
      `status-history-${randomUUID()}`,
      "order",
      order.id,
      order.status,
      "completed",
      "pickup_completed_before_window_expired",
      actorUserId,
      now
    );
    return { expired: false, completedPickedUp: true };
  }

  return { expired: false, completedPickedUp: false };
}

function expireGroupBuyPickupWindow(activityId, input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const actorUserId = input.actorUserId || null;
  let transactionStarted = false;

  try {
    const activity = database.prepare(`
      SELECT id, status, pickup_start_at, pickup_end_at
      FROM group_buy_activities
      WHERE id = ?
    `).get(activityId);
    if (!activity) {
      return { status: "not_found", activityId };
    }

    const expiresAt = calculatePickupExpirationAt(activity.pickup_start_at, activity.pickup_end_at);
    const expiresTime = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const nowTime = Date.parse(now);
    if (Number.isNaN(expiresTime) || Number.isNaN(nowTime)) {
      return { status: "invalid_pickup_window", activityId, expiresAt };
    }
    if (nowTime < expiresTime) {
      return { status: "not_due", activityId, expiresAt };
    }
    if (activity.status === "completed") {
      return { status: "already_completed", activityId, expiresAt };
    }
    if (!["ordering", "ready_for_pickup"].includes(activity.status)) {
      return { status: "not_expirable", activityId, activityStatus: activity.status, expiresAt };
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const claimActivity = database.prepare(`
      UPDATE group_buy_activities
      SET status = 'completed',
          updated_at = ?
      WHERE id = ?
        AND status IN ('ordering', 'ready_for_pickup')
    `).run(now, activityId);
    if (claimActivity.changes !== 1) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return { status: "already_processed", activityId, expiresAt };
    }

    const orders = database.prepare(`
      SELECT id, status, payment_status, pickup_status
      FROM orders
      WHERE activity_id = ?
      ORDER BY submitted_at ASC, id ASC
    `).all(activityId);
    const expireOrder = database.prepare(`
      UPDATE orders
      SET status = 'completed',
          pickup_status = 'expired',
          updated_at = ?
      WHERE id = ?
        AND payment_status = 'captured'
        AND pickup_status IN ('not_ready', 'ready')
        AND status != 'cancelled'
    `);
    const completePickedUpOrder = database.prepare(`
      UPDATE orders
      SET status = 'completed',
          updated_at = ?
      WHERE id = ?
        AND payment_status = 'captured'
        AND pickup_status = 'picked_up'
        AND status != 'completed'
        AND status != 'cancelled'
    `);
    const insertHistory = database.prepare(`
      INSERT INTO status_history (
        id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let expiredOrderCount = 0;
    let completedPickedUpOrderCount = 0;

    for (const order of orders) {
      const outcome = applyPickupWindowExpirationToOrder(order, {
        expireOrder,
        completePickedUpOrder,
        insertHistory,
        now,
        actorUserId
      });
      if (outcome.expired) expiredOrderCount += 1;
      if (outcome.completedPickedUp) completedPickedUpOrderCount += 1;
    }

    database.prepare(`
      UPDATE pickup_credentials
      SET expires_at = COALESCE(expires_at, ?),
          expired_at = CASE
            WHEN order_id IN (
              SELECT id
              FROM orders
              WHERE activity_id = ?
                AND pickup_status = 'expired'
            ) THEN COALESCE(expired_at, ?)
            ELSE expired_at
          END
      WHERE order_id IN (
        SELECT id
        FROM orders
        WHERE activity_id = ?
      )
    `).run(expiresAt, activityId, now, activityId);

    insertHistory.run(
      `status-history-${randomUUID()}`,
      "activity",
      activityId,
      activity.status,
      "completed",
      "pickup_window_expired",
      actorUserId,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'system_expire_pickup_window', 'activity', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      actorUserId,
      activityId,
      JSON.stringify({
        expiresAt,
        expiredOrderCount,
        completedPickedUpOrderCount
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;
    return {
      status: "completed",
      activityId,
      expiresAt,
      expiredOrderCount,
      completedPickedUpOrderCount
    };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function createGroupBuySettlementPlan(activityId, input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const actorUserId = input.actorUserId || null;
  const force = Boolean(input.force);
  let transactionStarted = false;

  try {
    const existingSettlement = database.prepare(`
      SELECT *
      FROM activity_settlements
      WHERE activity_id = ?
    `).get(activityId);
    if (existingSettlement) {
      return {
        error: "activity_already_settled",
        settlement: mapActivitySettlement(existingSettlement)
      };
    }

    const activity = database.prepare(`
      SELECT *
      FROM group_buy_activities
      WHERE id = ?
    `).get(activityId);
    if (!activity) {
      return null;
    }

    if (activity.status === "cancelled") {
      return { error: "activity_cancelled", status: activity.status };
    }

    if (["failed", "completed", "ready_for_pickup"].includes(activity.status)) {
      return { error: "activity_not_settleable", status: activity.status };
    }

    if (!force && Date.parse(activity.deadline_at) > Date.parse(now)) {
      return {
        error: "settlement_not_due",
        deadlineAt: activity.deadline_at,
        now
      };
    }

    const tiers = database.prepare(`
      SELECT id, target_cups, discount_percent, sort_order
      FROM promotion_tiers
      WHERE activity_id = ?
      ORDER BY target_cups ASC, sort_order ASC
    `).all(activityId);

    const orderRows = database.prepare(`
      SELECT
        orders.*,
        authorization.id AS payment_authorization_id,
        authorization.provider AS payment_provider,
        authorization.provider_authorization_id,
        authorization.authorized_amount,
        authorization.status AS payment_authorization_status
      FROM orders
      LEFT JOIN payment_authorizations authorization
        ON authorization.id = (
          SELECT id
          FROM payment_authorizations
          WHERE order_id = orders.id
            AND status IN ('authorized', 'captured')
          ORDER BY authorized_at DESC, created_at DESC
          LIMIT 1
        )
      WHERE orders.activity_id = ?
        AND orders.payment_status IN ('authorized', 'captured')
        AND orders.status NOT IN ('cancelled')
      ORDER BY orders.submitted_at ASC
    `).all(activityId);

    const authorizedCups = orderRows.reduce((sum, order) => sum + order.total_cups, 0);
    const discountSummary = resolveAppliedDiscountTier(tiers, authorizedCups);
    const appliedTier = tiers.find((tier) => tier.id === discountSummary.currentTierId) || null;
    const outcome = appliedTier ? "qualified" : "failed";
    const discountPercent = discountSummary.currentTierDiscountPercent;
    const settlementOrders = orderRows.map((order) => mapSettlementOrder(order, {
      outcome,
      appliedTier,
      discountPercent
    }));
    const totalDiscountAmount = settlementOrders.reduce((sum, order) => sum + order.discountAmount, 0);
    const capturedOrderCount = settlementOrders
      .filter((order) => order.action === "already_captured")
      .length;

    database.exec("BEGIN;");
    transactionStarted = true;

    if (activity.status !== "ordering") {
      database.prepare(`
        UPDATE group_buy_activities
        SET status = 'ordering',
            updated_at = ?
        WHERE id = ?
      `).run(now, activityId);

      database.prepare(`
        INSERT INTO status_history (
          id,
          resource_type,
          resource_id,
          from_status,
          to_status,
          reason,
          actor_user_id,
          created_at
        ) VALUES (?, 'activity', ?, ?, 'ordering', 'deadline_settlement_started', ?, ?)
      `).run(
        `status-history-${randomUUID()}`,
        activityId,
        activity.status,
        actorUserId,
        now
      );
    }

    database.prepare(`
      UPDATE orders
      SET status = 'locked',
          updated_at = ?
      WHERE activity_id = ?
        AND status = 'submitted'
        AND payment_status = 'authorized'
    `).run(now, activityId);

    // Orders whose customer never even attempted LINE Pay (payment_status stays 'pending'
    // forever) are otherwise invisible to settlement -- they'd sit as "active" indefinitely
    // since getOrderLifecycleBucket has no pending-forever branch. Resolve them to cancelled
    // now that the deadline has passed, using the same field set the merchant/customer cancel
    // paths use elsewhere in this file, so they correctly reclassify into order history.
    const neverPaidOrderCount = database.prepare(`
      UPDATE orders
      SET status = 'cancelled', pickup_status = 'cancelled', merchant_acceptance_status = 'cancelled',
          updated_at = ?
      WHERE activity_id = ?
        AND status = 'submitted'
        AND payment_status = 'pending'
    `).run(now, activityId).changes;

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, 'start_group_buy_settlement', 'activity', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      actorUserId,
      activityId,
      JSON.stringify({
        force,
        authorizedCups,
        outcome,
        appliedTierId: appliedTier?.id || null,
        discountPercent,
        totalDiscountAmount,
        discountFunder: "merchant",
        neverPaidOrderCount
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      activity: mapSettlementActivity(activity),
      outcome,
      authorizedCups,
      appliedTier: appliedTier ? mapSettlementTier(appliedTier) : null,
      discountPercent,
      totalDiscountAmount,
      discountFunder: "merchant",
      capturedOrderCount,
      neverPaidOrderCount,
      orders: settlementOrders
    };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function completeGroupBuySettlement(activityId, input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const settlementId = `activity-settlement-${randomUUID()}`;
  const actorUserId = input.actorUserId || null;
  const outcome = input.outcome || "failed";
  const capturedOrderCount = Number(input.capturedOrderCount || 0);
  const finalStatus = outcome === "qualified" || capturedOrderCount > 0
    ? "ordering"
    : "failed";
  let transactionStarted = false;

  try {
    const existingSettlement = database.prepare(`
      SELECT *
      FROM activity_settlements
      WHERE activity_id = ?
    `).get(activityId);
    if (existingSettlement) {
      return {
        settlement: mapActivitySettlement(existingSettlement),
        alreadyCompleted: true
      };
    }

    const activity = database.prepare(`
      SELECT id, status
      FROM group_buy_activities
      WHERE id = ?
    `).get(activityId);
    if (!activity) {
      return null;
    }

    database.exec("BEGIN;");
    transactionStarted = true;

    database.prepare(`
      INSERT INTO activity_settlements (
        id,
        activity_id,
        outcome,
        authorized_cups,
        applied_tier_id,
        total_discount_amount,
        discount_percent,
        settled_at,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      settlementId,
      activityId,
      outcome,
      Number(input.authorizedCups || 0),
      input.appliedTierId || null,
      Number(input.totalDiscountAmount || 0),
      outcome === "qualified" ? Number(input.discountPercent) : null,
      now,
      input.reason || "deadline_settlement_completed"
    );

    database.prepare(`
      UPDATE group_buy_activities
      SET status = ?,
          updated_at = ?
      WHERE id = ?
    `).run(finalStatus, now, activityId);

    if (activity.status !== finalStatus) {
      database.prepare(`
        INSERT INTO status_history (
          id,
          resource_type,
          resource_id,
          from_status,
          to_status,
          reason,
          actor_user_id,
          created_at
        ) VALUES (?, 'activity', ?, ?, ?, 'deadline_settlement_completed', ?, ?)
      `).run(
        `status-history-${randomUUID()}`,
        activityId,
        activity.status,
        finalStatus,
        actorUserId,
        now
      );
    }

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, 'complete_group_buy_settlement', 'activity', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      actorUserId,
      activityId,
      JSON.stringify({
        outcome,
        finalStatus,
        capturedOrderCount,
        voidedOrderCount: Number(input.voidedOrderCount || 0),
        failedOrderCount: Number(input.failedOrderCount || 0),
        appliedTierId: input.appliedTierId || null,
        totalDiscountAmount: Number(input.totalDiscountAmount || 0),
        discountPercent: input.discountPercent ?? null
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      settlement: getActivitySettlementByActivityId(activityId),
      activity: listGroupBuyActivities().find((activityItem) => activityItem.id === activityId)
    };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function getUserAuthProfileByFirebaseUid(firebaseUid) {
  const database = openDatabase();
  try {
    const user = database.prepare(`
      SELECT id, login_name, phone_number, email, display_name, surname, status
      FROM users
      WHERE firebase_uid = ?
        AND status = 'active'
    `).get(firebaseUid);

    return user ? hydrateUserAuthProfile(database, user) : null;
  } finally {
    database.close();
  }
}

function getUserAuthProfileById(userId) {
  const database = openDatabase();
  try {
    const user = database.prepare(`
      SELECT id, login_name, phone_number, email, display_name, surname, status
      FROM users
      WHERE id = ?
        AND status = 'active'
    `).get(userId);

    return user ? hydrateUserAuthProfile(database, user) : null;
  } finally {
    database.close();
  }
}

function listDevAuthUsers() {
  const database = openDatabase();
  try {
    const rows = database.prepare(`
      SELECT DISTINCT
        u.id,
        u.login_name,
        u.phone_number,
        u.email,
        u.display_name,
        u.surname,
        u.status
      FROM users u
      JOIN user_roles user_role ON user_role.user_id = u.id
      WHERE u.status = 'active'
        AND user_role.status = 'active'
        AND user_role.role IN ('customer', 'merchant', 'admin')
      ORDER BY
        CASE
          WHEN user_role.role = 'customer' THEN 1
          WHEN user_role.role = 'merchant' THEN 2
          ELSE 3
        END,
        u.id ASC
    `).all();

    return rows.map((row) => toDevAuthUser(hydrateUserAuthProfile(database, row)));
  } finally {
    database.close();
  }
}

const defaultCustomizationRules = {
  sweetness: { minSelections: 1, maxSelections: 1 },
  ice: { minSelections: 1, maxSelections: 1 },
  size: { minSelections: 1, maxSelections: 1 },
  topping: { minSelections: 0, maxSelections: 1 }
};

function listStoreMenu(storeId, input = {}) {
  const database = openDatabase();
  const includeUnavailable = Boolean(input.includeUnavailable);
  try {
    const store = database.prepare(`
      SELECT id, merchant_id, name, address, phone, business_status
      FROM stores
      WHERE id = ?
    `).get(storeId);
    if (!store) return null;

    const menuItems = database.prepare(`
      SELECT id, store_id, name, category, description, base_price, is_available
      FROM menu_items
      WHERE store_id = ?
        AND (? = 1 OR is_available = 1)
      ORDER BY category ASC, name ASC, id ASC
    `).all(storeId, includeUnavailable ? 1 : 0);
    const optionRows = database.prepare(`
      SELECT option.id, option.menu_item_id, option.option_type, option.label,
             option.price_delta, option.sort_order, option.is_available
      FROM customization_options option
      JOIN menu_items menu_item ON menu_item.id = option.menu_item_id
      WHERE menu_item.store_id = ?
        AND (? = 1 OR option.is_available = 1)
      ORDER BY option.menu_item_id, option.option_type, option.sort_order, option.id
    `).all(storeId, includeUnavailable ? 1 : 0);
    const ruleRows = database.prepare(`
      SELECT rule.menu_item_id, rule.option_type, rule.min_selections, rule.max_selections
      FROM menu_item_customization_rules rule
      JOIN menu_items menu_item ON menu_item.id = rule.menu_item_id
      WHERE menu_item.store_id = ?
    `).all(storeId);

    return {
      store: {
        id: store.id,
        merchantId: store.merchant_id,
        name: store.name,
        address: store.address,
        phone: store.phone,
        businessStatus: store.business_status
      },
      menuItems: menuItems.map((menuItem) => mapMenuItem(
        menuItem,
        optionRows.filter((option) => option.menu_item_id === menuItem.id),
        ruleRows.filter((rule) => rule.menu_item_id === menuItem.id),
        includeUnavailable
      ))
    };
  } finally {
    database.close();
  }
}

function saveMerchantMenuItem(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const menuItemId = input.menuItemId || `menu-item-${randomUUID()}`;
  const creating = !input.menuItemId;
  let transactionStarted = false;

  try {
    const store = database.prepare("SELECT id FROM stores WHERE id = ?").get(input.storeId);
    if (!store) return { error: "store_not_found" };

    const existingItem = database.prepare(`
      SELECT id, store_id
      FROM menu_items
      WHERE id = ?
    `).get(menuItemId);
    if (!creating && !existingItem) return { error: "menu_item_not_found" };
    if (existingItem && existingItem.store_id !== input.storeId) {
      return { error: "menu_item_store_mismatch" };
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    if (creating) {
      database.prepare(`
        INSERT INTO menu_items (
          id, store_id, name, category, description, base_price, is_available, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        menuItemId,
        input.storeId,
        input.name,
        input.category,
        input.description || null,
        Number(input.basePrice),
        input.isAvailable ? 1 : 0,
        now,
        now
      );
    } else {
      database.prepare(`
        UPDATE menu_items
        SET name = ?, category = ?, description = ?, base_price = ?, is_available = ?, updated_at = ?
        WHERE id = ? AND store_id = ?
      `).run(
        input.name,
        input.category,
        input.description || null,
        Number(input.basePrice),
        input.isAvailable ? 1 : 0,
        now,
        menuItemId,
        input.storeId
      );
    }

    const upsertRule = database.prepare(`
      INSERT INTO menu_item_customization_rules (
        menu_item_id, option_type, min_selections, max_selections, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(menu_item_id, option_type) DO UPDATE SET
        min_selections = excluded.min_selections,
        max_selections = excluded.max_selections,
        updated_at = excluded.updated_at
    `);
    const existingOptions = database.prepare(`
      SELECT id, option_type
      FROM customization_options
      WHERE menu_item_id = ?
    `).all(menuItemId);
    const updateOption = database.prepare(`
      UPDATE customization_options
      SET option_type = ?, label = ?, price_delta = ?, sort_order = ?, is_available = ?
      WHERE id = ? AND menu_item_id = ?
    `);
    const insertOption = database.prepare(`
      INSERT INTO customization_options (
        id, menu_item_id, option_type, label, price_delta, sort_order, is_available
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const group of input.customizationGroups) {
      upsertRule.run(
        menuItemId,
        group.optionType,
        Number(group.minSelections),
        Number(group.maxSelections),
        now,
        now
      );

      const submittedOptionIds = new Set();
      for (const [index, option] of group.options.entries()) {
        const optionId = option.id || `customization-option-${randomUUID()}`;
        const existingOption = existingOptions.find((item) => item.id === optionId);
        const optionWithSameId = option.id
          ? database.prepare(`
            SELECT id, menu_item_id
            FROM customization_options
            WHERE id = ?
          `).get(optionId)
          : null;
        if (optionWithSameId && optionWithSameId.menu_item_id !== menuItemId) {
          database.exec("ROLLBACK;");
          transactionStarted = false;
          return { error: "customization_option_item_mismatch", optionId };
        }
        if (existingOption && existingOption.option_type !== group.optionType) {
          database.exec("ROLLBACK;");
          transactionStarted = false;
          return { error: "customization_option_type_mismatch", optionId };
        }
        submittedOptionIds.add(optionId);
        if (existingOption) {
          updateOption.run(
            group.optionType,
            option.label,
            Number(option.priceDelta),
            index,
            option.isAvailable ? 1 : 0,
            optionId,
            menuItemId
          );
        } else {
          insertOption.run(
            optionId,
            menuItemId,
            group.optionType,
            option.label,
            Number(option.priceDelta),
            index,
            option.isAvailable ? 1 : 0
          );
        }
      }

      for (const existingOption of existingOptions.filter((item) => item.option_type === group.optionType)) {
        if (!submittedOptionIds.has(existingOption.id)) {
          database.prepare(`
            UPDATE customization_options
            SET is_available = 0
            WHERE id = ? AND menu_item_id = ?
          `).run(existingOption.id, menuItemId);
        }
      }
    }

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, ?, 'menu_item', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.actorUserId,
      creating ? "merchant_create_menu_item" : "merchant_update_menu_item",
      menuItemId,
      JSON.stringify({ storeId: input.storeId, isAvailable: input.isAvailable }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;
    return { menuItem: listStoreMenu(input.storeId, { includeUnavailable: true })
      .menuItems.find((item) => item.id === menuItemId) };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function createOrder(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const orderId = `order-${randomUUID()}`;
  let transactionStarted = false;

  try {
    const activity = database.prepare(`
      SELECT id, store_id, status, deadline_at, maximum_cups
      FROM group_buy_activities
      WHERE id = ?
    `).get(input.activityId);
    if (!activity) {
      return { error: "activity_not_found" };
    }
    if (!["recruiting", "confirmed"].includes(activity.status)) {
      return { error: "activity_not_joinable", status: activity.status };
    }
    if (Date.parse(now) >= Date.parse(activity.deadline_at)) {
      return {
        error: "activity_not_joinable",
        status: activity.status,
        reason: "deadline_passed"
      };
    }

    const pricedItems = priceOrderItems(database, activity.store_id, input.items);
    if (pricedItems.error) return pricedItems;
    const items = pricedItems.items;
    const totalCups = items.reduce((sum, item) => sum + item.quantity, 0);
    const originalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);
    if (pricedItems.priceChanged) {
      return {
        error: "order_price_changed",
        originalAmount,
        items: toAuthoritativeOrderItems(items)
      };
    }

    const user = database.prepare(`
      SELECT id
      FROM users
      WHERE id = ?
        AND status = 'active'
    `).get(input.customerUserId);
    if (!user) {
      return { error: "customer_not_found" };
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const existingOrder = database.prepare(`
      SELECT id
      FROM orders
      WHERE activity_id = ?
        AND customer_user_id = ?
        AND status != 'cancelled'
      ORDER BY submitted_at DESC
      LIMIT 1
    `).get(input.activityId, input.customerUserId);
    if (existingOrder) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return { error: "order_already_exists", orderId: existingOrder.id };
    }

    const authorizedCups = database.prepare(`
      SELECT COALESCE(SUM(total_cups), 0) AS cups
      FROM orders
      WHERE activity_id = ?
        AND payment_status IN ('authorized', 'captured')
        AND status NOT IN ('cancelled')
    `).get(input.activityId).cups;

    if (activity.maximum_cups && authorizedCups + totalCups > activity.maximum_cups) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return {
        error: "capacity_exceeded",
        maximumCups: activity.maximum_cups,
        authorizedCups,
        requestedCups: totalCups
      };
    }

    database.prepare(`
      INSERT INTO orders (
        id,
        activity_id,
        customer_user_id,
        status,
        fallback_purchase_preference,
        total_cups,
        original_amount,
        payment_status,
        authorization_status,
        merchant_acceptance_status,
        pickup_status,
        submitted_at,
        updated_at
      ) VALUES (?, ?, ?, 'submitted', ?, ?, ?, 'pending', 'pending', 'pending', 'not_ready', ?, ?)
    `).run(
      orderId,
      input.activityId,
      input.customerUserId,
      input.fallbackPurchasePreference || "decline_original_price",
      totalCups,
      originalAmount,
      now,
      now
    );

    const insertOrderItem = database.prepare(`
      INSERT INTO order_items (
        id,
        order_id,
        menu_item_id,
        item_name_snapshot,
        quantity,
        unit_price_snapshot,
        subtotal
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCustomization = database.prepare(`
      INSERT INTO order_item_customizations (
        id,
        order_item_id,
        customization_option_id,
        option_type,
        label_snapshot,
        price_delta_snapshot,
        sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item) => {
      const orderItemId = `order-item-${randomUUID()}`;
      const menuItem = item.menuItemId
        ? database.prepare("SELECT id FROM menu_items WHERE id = ?").get(item.menuItemId)
        : null;

      insertOrderItem.run(
        orderItemId,
        orderId,
        menuItem?.id ?? null,
        item.itemName,
        item.quantity,
        item.unitPrice,
        item.subtotal
      );

      item.customizations.forEach((customization, index) => {
        insertCustomization.run(
          `order-item-customization-${randomUUID()}`,
          orderItemId,
          customization.optionId,
          customization.optionType,
          customization.label,
          customization.priceDelta,
          index
        );
      });
    });

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'order', ?, NULL, 'submitted', 'customer_submit_cart', ?, ?)
    `).run(
      `status-history-${randomUUID()}`,
      orderId,
      input.customerUserId,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, 'customer_create_order', 'order', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.customerUserId,
      orderId,
      JSON.stringify({
        activityId: input.activityId,
        totalCups,
        originalAmount
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return { order: getOrderById(orderId) };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function updatePendingOrder(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  let transactionStarted = false;

  try {
    const order = database.prepare(`
      SELECT id, activity_id, customer_user_id, status, payment_status
      FROM orders
      WHERE id = ?
    `).get(input.orderId);

    if (!order) {
      return { error: "order_not_found" };
    }
    if (order.customer_user_id !== input.customerUserId) {
      return { error: "order_access_denied" };
    }
    if (order.status !== "submitted" || order.payment_status !== "pending") {
      return {
        error: "order_not_editable",
        status: order.status,
        paymentStatus: order.payment_status
      };
    }

    const activity = database.prepare(`
      SELECT id, store_id, status, maximum_cups
      FROM group_buy_activities
      WHERE id = ?
    `).get(order.activity_id);
    if (!activity) {
      return { error: "activity_not_found" };
    }
    if (!["recruiting", "confirmed"].includes(activity.status)) {
      return { error: "activity_not_joinable", status: activity.status };
    }

    const pricedItems = priceOrderItems(database, activity.store_id, input.items);
    if (pricedItems.error) return pricedItems;
    const items = pricedItems.items;
    const totalCups = items.reduce((sum, item) => sum + item.quantity, 0);
    const originalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);
    if (pricedItems.priceChanged) {
      return {
        error: "order_price_changed",
        originalAmount,
        items: toAuthoritativeOrderItems(items)
      };
    }

    const authorizedCups = database.prepare(`
      SELECT COALESCE(SUM(total_cups), 0) AS cups
      FROM orders
      WHERE activity_id = ?
        AND id != ?
        AND payment_status IN ('authorized', 'captured')
        AND status NOT IN ('cancelled')
    `).get(order.activity_id, input.orderId).cups;

    if (activity.maximum_cups && authorizedCups + totalCups > activity.maximum_cups) {
      return {
        error: "capacity_exceeded",
        maximumCups: activity.maximum_cups,
        authorizedCups,
        requestedCups: totalCups
      };
    }

    const pendingAuthorizations = database.prepare(`
      SELECT id, status, provider_authorization_id
      FROM payment_authorizations
      WHERE order_id = ?
        AND status = 'pending'
    `).all(input.orderId);

    database.exec("BEGIN;");
    transactionStarted = true;

    for (const authorization of pendingAuthorizations) {
      database.prepare(`
        UPDATE payment_authorizations
        SET status = 'failed',
            failure_reason = 'order_updated_before_authorization',
            updated_at = ?
        WHERE id = ?
      `).run(now, authorization.id);

      database.prepare(`
        INSERT INTO status_history (
          id,
          resource_type,
          resource_id,
          from_status,
          to_status,
          reason,
          actor_user_id,
          created_at
        ) VALUES (?, 'payment_authorization', ?, 'pending', 'failed', 'order_updated_before_authorization', ?, ?)
      `).run(
        `status-history-${randomUUID()}`,
        authorization.id,
        input.customerUserId,
        now
      );
    }

    database.prepare(`
      DELETE FROM order_item_customizations
      WHERE order_item_id IN (
        SELECT id
        FROM order_items
        WHERE order_id = ?
      )
    `).run(input.orderId);
    database.prepare("DELETE FROM order_items WHERE order_id = ?").run(input.orderId);

    const insertOrderItem = database.prepare(`
      INSERT INTO order_items (
        id,
        order_id,
        menu_item_id,
        item_name_snapshot,
        quantity,
        unit_price_snapshot,
        subtotal
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertCustomization = database.prepare(`
      INSERT INTO order_item_customizations (
        id,
        order_item_id,
        customization_option_id,
        option_type,
        label_snapshot,
        price_delta_snapshot,
        sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach((item) => {
      const orderItemId = `order-item-${randomUUID()}`;
      const menuItem = item.menuItemId
        ? database.prepare("SELECT id FROM menu_items WHERE id = ?").get(item.menuItemId)
        : null;

      insertOrderItem.run(
        orderItemId,
        input.orderId,
        menuItem?.id ?? null,
        item.itemName,
        item.quantity,
        item.unitPrice,
        item.subtotal
      );

      item.customizations.forEach((customization, index) => {
        insertCustomization.run(
          `order-item-customization-${randomUUID()}`,
          orderItemId,
          customization.optionId,
          customization.optionType,
          customization.label,
          customization.priceDelta,
          index
        );
      });
    });

    database.prepare(`
      UPDATE orders
      SET fallback_purchase_preference = ?,
          total_cups = ?,
          original_amount = ?,
          final_amount = NULL,
          payment_status = 'pending',
          authorization_status = 'pending',
          merchant_acceptance_status = 'pending',
          pickup_status = 'not_ready',
          updated_at = ?
      WHERE id = ?
    `).run(
      input.fallbackPurchasePreference || "decline_original_price",
      totalCups,
      originalAmount,
      now,
      input.orderId
    );

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'order', ?, 'submitted', 'submitted', 'customer_update_pending_order', ?, ?)
    `).run(
      `status-history-${randomUUID()}`,
      input.orderId,
      input.customerUserId,
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      order: getOrderById(input.orderId),
      failedAuthorizations: pendingAuthorizations.map((authorization) => ({
        id: authorization.id,
        providerAuthorizationId: authorization.provider_authorization_id
      }))
    };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function createOrderRevision(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const revisionId = `order-revision-${randomUUID()}`;
  let transactionStarted = false;

  try {
    const order = database.prepare(`
      SELECT
        orders.id,
        orders.activity_id,
        orders.customer_user_id,
        orders.status,
        orders.payment_status,
        orders.authorization_status,
        orders.total_cups,
        orders.original_amount,
        activity.status AS activity_status,
        activity.store_id,
        activity.maximum_cups,
        activity.deadline_at,
        activity.withdrawal_lock_minutes
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE orders.id = ?
    `).get(input.orderId);

    if (!order) {
      return { error: "order_not_found" };
    }
    if (order.customer_user_id !== input.customerUserId) {
      return { error: "order_access_denied" };
    }
    if (
      order.status !== "submitted"
      || order.payment_status !== "authorized"
      || order.authorization_status !== "authorized"
    ) {
      return {
        error: "order_not_revisable",
        status: order.status,
        paymentStatus: order.payment_status,
        authorizationStatus: order.authorization_status
      };
    }
    if (!["recruiting", "confirmed"].includes(order.activity_status)) {
      return { error: "activity_not_joinable", status: order.activity_status };
    }

    const pricedItems = priceOrderItems(database, order.store_id, input.items);
    if (pricedItems.error) return pricedItems;
    const items = pricedItems.items;
    const totalCups = items.reduce((sum, item) => sum + item.quantity, 0);
    const originalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);
    if (pricedItems.priceChanged) {
      return {
        error: "order_price_changed",
        originalAmount,
        items: toAuthoritativeOrderItems(items)
      };
    }

    const lockMinutes = Number(order.withdrawal_lock_minutes || 30);
    const deadlineTime = Date.parse(order.deadline_at);
    const nowTime = Date.parse(now);
    // The withdrawal-lock formula (deadlineTime - nowTime <= lockMinutes) has no upper bound, so
    // it also covers every moment after the deadline, not just the last lockMinutes before it. Any
    // revision -- increase included -- must still be rejected once the deadline has actually passed;
    // only within the pre-deadline lock window is a non-decreasing revision allowed through.
    const isPastDeadline = !Number.isNaN(deadlineTime) && nowTime >= deadlineTime;
    if (isPastDeadline) {
      return {
        error: "order_locked_by_deadline",
        deadlineAt: order.deadline_at,
        lockMinutes
      };
    }
    const withinWithdrawalLock = !Number.isNaN(deadlineTime) && deadlineTime - nowTime <= lockMinutes * 60 * 1000;
    if (withinWithdrawalLock && totalCups < order.total_cups) {
      return {
        error: "order_locked_by_deadline",
        deadlineAt: order.deadline_at,
        lockMinutes
      };
    }

    const pendingRevision = database.prepare(`
      SELECT id
      FROM order_revisions
      WHERE order_id = ?
        AND status = 'pending_authorization'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(input.orderId);
    if (pendingRevision) {
      return {
        error: "order_revision_already_pending",
        orderRevisionId: pendingRevision.id
      };
    }

    const originalAuthorization = database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE order_id = ?
        AND status = 'authorized'
      ORDER BY authorized_at DESC, created_at DESC
      LIMIT 1
    `).get(input.orderId);
    if (!originalAuthorization) {
      return { error: "order_authorization_missing" };
    }

    const authorizedCups = database.prepare(`
      SELECT COALESCE(SUM(total_cups), 0) AS cups
      FROM orders
      WHERE activity_id = ?
        AND id != ?
        AND payment_status IN ('authorized', 'captured')
        AND status NOT IN ('cancelled')
    `).get(order.activity_id, input.orderId).cups;

    if (order.maximum_cups && authorizedCups + totalCups > order.maximum_cups) {
      return {
        error: "capacity_exceeded",
        maximumCups: order.maximum_cups,
        authorizedCups,
        requestedCups: totalCups
      };
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    database.prepare(`
      INSERT INTO order_revisions (
        id,
        order_id,
        status,
        original_payment_authorization_id,
        fallback_purchase_preference,
        previous_total_cups,
        previous_original_amount,
        total_cups,
        original_amount,
        created_at,
        updated_at
      ) VALUES (?, ?, 'pending_authorization', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      input.orderId,
      originalAuthorization.id,
      input.fallbackPurchasePreference || order.fallback_purchase_preference || "decline_original_price",
      order.total_cups,
      order.original_amount,
      totalCups,
      originalAmount,
      now,
      now
    );

    insertOrderRevisionItems(database, revisionId, items);

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, ?, 'customer_create_order_revision', 'order', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.customerUserId,
      input.orderId,
      JSON.stringify({
        orderRevisionId: revisionId,
        previousTotalCups: order.total_cups,
        requestedTotalCups: totalCups,
        previousOriginalAmount: order.original_amount,
        requestedOriginalAmount: originalAmount
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return { revision: getOrderRevisionById(revisionId) };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function insertOrderRevisionItems(database, revisionId, items) {
  const insertRevisionItem = database.prepare(`
    INSERT INTO order_revision_items (
      id,
      order_revision_id,
      menu_item_id,
      item_name_snapshot,
      quantity,
      unit_price_snapshot,
      subtotal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertRevisionCustomization = database.prepare(`
    INSERT INTO order_revision_item_customizations (
      id,
      order_revision_item_id,
      customization_option_id,
      option_type,
      label_snapshot,
      price_delta_snapshot,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  items.forEach((item) => {
    const revisionItemId = `order-revision-item-${randomUUID()}`;
    const menuItem = item.menuItemId
      ? database.prepare("SELECT id FROM menu_items WHERE id = ?").get(item.menuItemId)
      : null;

    insertRevisionItem.run(
      revisionItemId,
      revisionId,
      menuItem?.id ?? null,
      item.itemName,
      item.quantity,
      item.unitPrice,
      item.subtotal
    );

    item.customizations.forEach((customization, index) => {
      insertRevisionCustomization.run(
        `order-revision-item-customization-${randomUUID()}`,
        revisionItemId,
        customization.optionId,
        customization.optionType,
        customization.label,
        customization.priceDelta,
        index
      );
    });
  });
}

function copyOrderRevisionItemsToOrder(database, revisionId, orderId) {
  const revisionItems = database.prepare(`
    SELECT *
    FROM order_revision_items
    WHERE order_revision_id = ?
    ORDER BY rowid ASC
  `).all(revisionId);
  const revisionCustomizations = database.prepare(`
    SELECT *
    FROM order_revision_item_customizations
    WHERE order_revision_item_id = ?
    ORDER BY sort_order ASC
  `);
  const insertOrderItem = database.prepare(`
    INSERT INTO order_items (
      id,
      order_id,
      menu_item_id,
      item_name_snapshot,
      quantity,
      unit_price_snapshot,
      subtotal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrderCustomization = database.prepare(`
    INSERT INTO order_item_customizations (
      id,
      order_item_id,
      customization_option_id,
      option_type,
      label_snapshot,
      price_delta_snapshot,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  revisionItems.forEach((item) => {
    const orderItemId = `order-item-${randomUUID()}`;
    insertOrderItem.run(
      orderItemId,
      orderId,
      item.menu_item_id,
      item.item_name_snapshot,
      item.quantity,
      item.unit_price_snapshot,
      item.subtotal
    );

    revisionCustomizations.all(item.id).forEach((customization, index) => {
      insertOrderCustomization.run(
        `order-item-customization-${randomUUID()}`,
        orderItemId,
        customization.customization_option_id,
        customization.option_type,
        customization.label_snapshot,
        customization.price_delta_snapshot,
        index
      );
    });
  });
}

function getOrderPaymentContext(orderId) {
  const database = openDatabase();
  try {
    const order = database.prepare(`
      SELECT
        orders.id,
        orders.activity_id,
        orders.customer_user_id,
        orders.total_cups,
        orders.original_amount,
        orders.payment_status,
        orders.authorization_status,
        activity.deadline_at
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE orders.id = ?
    `).get(orderId);

    return order ? mapOrderPaymentContext(order) : null;
  } finally {
    database.close();
  }
}

function recordOrderRuleConsentInDatabase(input) {
  const database = openDatabase();
  const consentId = `rule-consent-${randomUUID()}`;
  try {
    database.prepare(`
      INSERT OR IGNORE INTO order_rule_consents (
        id,
        order_id,
        customer_user_id,
        rule_type,
        rule_version,
        rule_content_snapshot,
        consented_at
      )
      SELECT ?, orders.id, orders.customer_user_id, ?, ?, ?, ?
      FROM orders
      WHERE orders.id = ?
        AND orders.customer_user_id = ?
    `).run(
      consentId,
      input.ruleType,
      input.ruleVersion,
      input.ruleContentSnapshot,
      input.consentedAt,
      input.orderId,
      input.customerUserId
    );

    const row = database.prepare(`
      SELECT *
      FROM order_rule_consents
      WHERE order_id = ?
        AND rule_type = ?
        AND rule_version = ?
    `).get(input.orderId, input.ruleType, input.ruleVersion);
    return row ? mapOrderRuleConsent(row) : null;
  } finally {
    database.close();
  }
}

function mapOrderRuleConsent(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    customerUserId: row.customer_user_id,
    ruleType: row.rule_type,
    ruleVersion: row.rule_version,
    ruleContentSnapshot: row.rule_content_snapshot,
    consentedAt: row.consented_at
  };
}

function getOrderRevisionPaymentContext(orderRevisionId) {
  const database = openDatabase();
  try {
    const revision = database.prepare(`
      SELECT
        revision.id,
        revision.order_id,
        revision.status,
        revision.total_cups,
        revision.original_amount,
        orders.customer_user_id,
        orders.payment_status,
        orders.authorization_status,
        activity.deadline_at
      FROM order_revisions revision
      JOIN orders ON orders.id = revision.order_id
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE revision.id = ?
    `).get(orderRevisionId);

    return revision ? {
      id: revision.id,
      orderId: revision.order_id,
      status: revision.status,
      totalCups: revision.total_cups,
      originalAmount: revision.original_amount,
      customerUserId: revision.customer_user_id,
      paymentStatus: revision.payment_status,
      authorizationStatus: revision.authorization_status,
      deadlineAt: revision.deadline_at
    } : null;
  } finally {
    database.close();
  }
}

function getLatestLinePayAuthorizationForOrder(orderId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE order_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(orderId);

    return row ? mapPaymentAuthorization(row) : null;
  } finally {
    database.close();
  }
}

function getLatestLinePayAuthorizationForOrderRevision(orderRevisionId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE order_revision_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(orderRevisionId);

    return row ? mapPaymentAuthorization(row) : null;
  } finally {
    database.close();
  }
}

function getLinePayAuthorizationContext(input) {
  const database = openDatabase();
  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    const order = database.prepare(`
      SELECT id, original_amount
      FROM orders
      WHERE id = ?
    `).get(authorization.order_id);

    return {
      authorization: mapPaymentAuthorization(authorization),
      order: order
        ? {
            id: order.id,
            originalAmount: order.original_amount
          }
        : null,
      amount: authorization.original_amount,
      currency: process.env.LINE_PAY_CURRENCY || "TWD"
    };
  } finally {
    database.close();
  }
}

function getLinePayCaptureRetryState(input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const maxAttempts = normalizePositiveInteger(input.maxAttempts, 3);

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    const attempts = database.prepare(`
      SELECT *
      FROM payment_captures
      WHERE payment_authorization_id = ?
        AND status = 'failed'
      ORDER BY created_at DESC, id DESC
    `).all(authorization.id);
    const latestAttempt = attempts[0] || null;
    const attemptCount = attempts.length;
    const retryable = Boolean(latestAttempt?.retryable);
    const nextRetryAt = latestAttempt?.next_retry_at || null;
    const nextRetryTime = nextRetryAt ? Date.parse(nextRetryAt) : null;
    const nowTime = Date.parse(now);
    const exhausted = attemptCount >= maxAttempts || (attemptCount > 0 && !retryable);
    const retryDue = attemptCount === 0 || (
      !exhausted
      && !Number.isNaN(nowTime)
      && (nextRetryTime == null || Number.isNaN(nextRetryTime) || nextRetryTime <= nowTime)
    );

    return {
      authorization: mapPaymentAuthorization(authorization),
      attemptCount,
      maxAttempts,
      retryable,
      exhausted,
      retryDue,
      nextRetryAt,
      latestAttempt: latestAttempt ? mapPaymentCapture(latestAttempt) : null
    };
  } finally {
    database.close();
  }
}

function determineManualRepaymentIneligibilityReason({
  row,
  latestRepayment,
  terminalCaptureFailure,
  finalAmount,
  nowTime,
  cutoffTime
}) {
  if (row.payment_status === "captured" || latestRepayment?.status === "captured") {
    return "already_paid";
  }
  if (latestRepayment?.status === "pending") {
    return "repayment_already_pending";
  }
  if (row.payment_status !== "failed") {
    return "payment_not_failed";
  }
  if (!terminalCaptureFailure) {
    return "automatic_capture_not_finished";
  }
  if (!Number.isInteger(finalAmount) || finalAmount <= 0) {
    return "final_amount_missing";
  }
  if (Number.isNaN(nowTime) || Number.isNaN(cutoffTime) || nowTime >= cutoffTime) {
    return "manual_repayment_expired";
  }
  return null;
}

function getManualLinePayRepaymentContext(orderId, input = {}) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const cutoffMinutes = normalizePositiveInteger(input.cutoffMinutes, 15);

  try {
    const row = database.prepare(`
      SELECT
        orders.id,
        orders.customer_user_id,
        orders.status,
        orders.payment_status,
        orders.original_amount,
        orders.final_amount,
        activity.id AS activity_id,
        activity.status AS activity_status,
        activity.pickup_start_at,
        capture.id AS failed_capture_id,
        capture.final_amount AS failed_capture_final_amount,
        capture.attempt_number AS failed_capture_attempt_number,
        capture.retryable AS failed_capture_retryable,
        authorization.id AS original_authorization_id,
        authorization.provider AS original_provider,
        authorization.status AS original_authorization_status,
        authorization.provider_authorization_id AS original_provider_transaction_id
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      LEFT JOIN payment_captures capture
        ON capture.id = (
          SELECT id
          FROM payment_captures
          WHERE order_id = orders.id
            AND status = 'failed'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
      LEFT JOIN payment_authorizations authorization
        ON authorization.id = capture.payment_authorization_id
      WHERE orders.id = ?
    `).get(orderId);

    if (!row) return null;

    const latestRepayment = database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE order_id = ?
        AND payment_flow = 'direct_repayment'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(orderId);
    const pickupStartTime = Date.parse(row.pickup_start_at);
    const nowTime = Date.parse(now);
    const cutoffAt = Number.isNaN(pickupStartTime)
      ? null
      : new Date(pickupStartTime - cutoffMinutes * 60 * 1000).toISOString();
    const cutoffTime = cutoffAt ? Date.parse(cutoffAt) : Number.NaN;
    const finalAmount = Number(row.failed_capture_final_amount ?? row.final_amount ?? 0);
    const terminalCaptureFailure = Boolean(row.failed_capture_id)
      && !Boolean(row.failed_capture_retryable);

    const reason = determineManualRepaymentIneligibilityReason({
      row,
      latestRepayment,
      terminalCaptureFailure,
      finalAmount,
      nowTime,
      cutoffTime
    });

    return {
      orderId: row.id,
      customerUserId: row.customer_user_id,
      orderStatus: row.status,
      paymentStatus: row.payment_status,
      activityId: row.activity_id,
      activityStatus: row.activity_status,
      originalAmount: row.original_amount,
      finalAmount,
      pickupStartAt: row.pickup_start_at,
      cutoffAt,
      cutoffMinutes,
      eligible: reason == null,
      reason,
      failedCapture: row.failed_capture_id ? {
        id: row.failed_capture_id,
        attemptNumber: row.failed_capture_attempt_number,
        retryable: Boolean(row.failed_capture_retryable)
      } : null,
      originalAuthorization: row.original_authorization_id ? {
        id: row.original_authorization_id,
        provider: row.original_provider,
        status: row.original_authorization_status,
        providerAuthorizationId: row.original_provider_transaction_id
      } : null,
      latestRepayment: latestRepayment ? mapPaymentAuthorization(latestRepayment) : null
    };
  } finally {
    database.close();
  }
}

function getOrderRevisionById(orderRevisionId) {
  const database = openDatabase();
  try {
    const revision = database.prepare(`
      SELECT *
      FROM order_revisions
      WHERE id = ?
    `).get(orderRevisionId);
    if (!revision) return null;

    const items = database.prepare(`
      SELECT *
      FROM order_revision_items
      WHERE order_revision_id = ?
      ORDER BY rowid ASC
    `).all(orderRevisionId);
    const customizations = database.prepare(`
      SELECT *
      FROM order_revision_item_customizations
      WHERE order_revision_item_id = ?
      ORDER BY sort_order ASC
    `);

    return mapOrderRevision(revision, items.map((item) => ({
      ...item,
      customizations: customizations.all(item.id)
    })));
  } finally {
    database.close();
  }
}

function getOrderDetail(orderId, input = {}) {
  const order = getOrderById(orderId);
  if (!order) return null;
  const latestLinePayAuthorization = getLatestLinePayAuthorizationForOrder(orderId);
  const paymentRefunds = getPaymentRefundsByOrderId(orderId);
  return {
    ...order,
    latestLinePayAuthorization,
    latestPaymentCapture: latestLinePayAuthorization
      ? getLatestPaymentCaptureByAuthorizationId(latestLinePayAuthorization.id)
      : null,
    paymentRefunds,
    refundedAmount: paymentRefunds
      .filter((refund) => refund.status === "refunded")
      .reduce((sum, refund) => sum + refund.refundAmount, 0),
    pendingRevision: getPendingOrderRevisionByOrderId(orderId),
    manualRepayment: getManualLinePayRepaymentContext(orderId, { now: input.now })
  };
}

function cancelCustomerOrderInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  let transactionStarted = false;
  let result;
  try {
    const existingAction = input.idempotencyKey ? database.prepare(`
      SELECT order_id, actor_user_id, action_type, result_json
      FROM order_action_idempotency
      WHERE idempotency_key = ?
    `).get(input.idempotencyKey) : null;
    if (existingAction) {
      if (existingAction.order_id !== input.orderId
        || existingAction.actor_user_id !== input.customerUserId
        || existingAction.action_type !== "customer_cancel_order") {
        return { error: "idempotency_key_conflict" };
      }
      const storedResult = JSON.parse(existingAction.result_json);
      return { ...storedResult, order: getOrderDetail(storedResult.orderId), idempotent: true };
    }

    const eligibility = evaluateCustomerOrderCancellation(database, input, now);
    if (eligibility.error) return eligibility;
    const order = eligibility.order;
    if (eligibility.alreadyCancelled) return { order: getOrderDetail(order.id), idempotent: true };

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const updateResult = database.prepare(`
      UPDATE orders SET status = 'cancelled', pickup_status = 'cancelled',
        merchant_acceptance_status = 'cancelled', updated_at = ?
      WHERE id = ?
        AND status != 'cancelled'
        AND payment_status NOT IN ('captured', 'refunded')
    `).run(now, order.id);
    if (updateResult.changes !== 1) {
      const currentOrder = database.prepare("SELECT status, payment_status FROM orders WHERE id = ?").get(order.id);
      database.exec("ROLLBACK;");
      transactionStarted = false;
      if (currentOrder?.status === "cancelled") {
        return { order: getOrderDetail(order.id), idempotent: true };
      }
      if (["captured", "refunded"].includes(currentOrder?.payment_status)) {
        return { error: "captured_order_cannot_be_cancelled" };
      }
      return { error: "order_state_changed", status: currentOrder?.status, paymentStatus: currentOrder?.payment_status };
    }
    database.prepare(`
      UPDATE payment_authorizations SET status = 'failed', failure_reason = 'customer_cancelled_order', updated_at = ?
      WHERE order_id = ? AND status = 'pending'
    `).run(now, order.id);
    database.prepare(`
      UPDATE order_revisions SET status = 'cancelled', failure_reason = 'customer_cancelled_order',
        cancelled_at = ?, updated_at = ?
      WHERE order_id = ? AND status = 'pending_authorization'
    `).run(now, now, order.id);
    database.prepare(`
      INSERT INTO status_history (id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at)
      VALUES (?, 'order', ?, ?, 'cancelled', ?, ?, ?)
    `).run(`status-history-${randomUUID()}`, order.id, order.status, input.reason || "customer_withdrawal", input.customerUserId, now);
    database.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at)
      VALUES (?, ?, 'customer_cancel_order', 'order', ?, ?, ?)
    `).run(`audit-log-${randomUUID()}`, input.customerUserId, order.id, JSON.stringify({ reason: input.reason || "customer_withdrawal" }), now);
    result = { orderId: order.id, status: "cancelled", idempotent: false };
    if (input.idempotencyKey) database.prepare(`
      INSERT INTO order_action_idempotency (idempotency_key, order_id, action_type, actor_user_id, result_json, created_at)
      VALUES (?, ?, 'customer_cancel_order', ?, ?, ?)
    `).run(input.idempotencyKey, order.id, input.customerUserId, JSON.stringify(result), now);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
  return { ...result, order: getOrderDetail(input.orderId) };
}

function getCustomerOrderCancellationEligibility(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  try {
    const { order, ...eligibility } = evaluateCustomerOrderCancellation(database, input, now);
    return eligibility;
  } finally {
    database.close();
  }
}

function evaluateCustomerOrderCancellation(database, input, now) {
  const order = database.prepare(`
    SELECT orders.*, activity.deadline_at, activity.withdrawal_lock_minutes
    FROM orders
    JOIN group_buy_activities activity ON activity.id = orders.activity_id
    WHERE orders.id = ?
  `).get(input.orderId);
  if (!order) return { error: "order_not_found" };
  if (order.customer_user_id !== input.customerUserId) return { error: "order_access_denied" };
  if (order.status === "cancelled") return { eligible: true, alreadyCancelled: true, order };
  if (["captured", "refunded"].includes(order.payment_status)) {
    return { error: "captured_order_cannot_be_cancelled" };
  }
  if (!["pending", "authorized", "authorization_voided", "failed"].includes(order.payment_status)) {
    return { error: "order_not_cancellable", paymentStatus: order.payment_status };
  }
  const deadline = Date.parse(order.deadline_at);
  const lockMinutes = Number(order.withdrawal_lock_minutes || 30);
  if (!Number.isNaN(deadline) && deadline - Date.parse(now) <= lockMinutes * 60 * 1000) {
    return { error: "order_locked_by_deadline", deadlineAt: order.deadline_at, lockMinutes };
  }
  return { eligible: true, paymentStatus: order.payment_status, order };
}

function getMerchantGroupBuyActivityForCancellation(activityId) {
  const database = openDatabase();
  try {
    return database.prepare(`
      SELECT id, store_id, status, deadline_at, withdrawal_lock_minutes, cancellation_reason
      FROM group_buy_activities
      WHERE id = ?
    `).get(activityId) || null;
  } finally {
    database.close();
  }
}

function listEligibleOrdersForMerchantCancellation(activityId) {
  const database = openDatabase();
  try {
    return database.prepare(`
      SELECT
        orders.id,
        orders.payment_status,
        authorization.provider AS payment_provider
      FROM orders
      LEFT JOIN payment_authorizations authorization
        ON authorization.id = (
          SELECT id
          FROM payment_authorizations
          WHERE order_id = orders.id
            AND status IN ('authorized', 'captured')
          ORDER BY authorized_at DESC, created_at DESC
          LIMIT 1
        )
      WHERE orders.activity_id = ?
        AND orders.status != 'cancelled'
        AND orders.payment_status NOT IN ('captured', 'refunded')
    `).all(activityId);
  } finally {
    database.close();
  }
}

function evaluateMerchantOrderCancellation(database, input) {
  const order = database.prepare(`SELECT * FROM orders WHERE id = ?`).get(input.orderId);
  if (!order) return { error: "order_not_found" };
  if (order.activity_id !== input.activityId) return { error: "order_access_denied" };
  if (order.status === "cancelled") return { eligible: true, alreadyCancelled: true, order };
  if (["captured", "refunded"].includes(order.payment_status)) {
    return { error: "captured_order_cannot_be_cancelled" };
  }
  if (order.payment_status === "authorized") {
    return { error: "authorization_void_required", paymentStatus: order.payment_status };
  }
  // Defensive: payment_status is CHECK-constrained to {pending, authorized, captured,
  // authorization_voided, failed, refunded}, so this currently can't trigger against real data —
  // kept as a safety net against future schema changes rather than trusting the guards above alone.
  if (!["pending", "authorization_voided", "failed"].includes(order.payment_status)) {
    return { error: "order_not_cancellable", paymentStatus: order.payment_status };
  }
  return { eligible: true, paymentStatus: order.payment_status, order };
}

function cancelMerchantOrderInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  let transactionStarted = false;
  let result;
  try {
    const existingAction = input.idempotencyKey ? database.prepare(`
      SELECT order_id, actor_user_id, action_type, result_json
      FROM order_action_idempotency
      WHERE idempotency_key = ?
    `).get(input.idempotencyKey) : null;
    if (existingAction) {
      if (existingAction.order_id !== input.orderId
        || existingAction.actor_user_id !== input.actorUserId
        || existingAction.action_type !== "merchant_cancel_order") {
        return { error: "idempotency_key_conflict" };
      }
      const storedResult = JSON.parse(existingAction.result_json);
      return { ...storedResult, idempotent: true };
    }

    const eligibility = evaluateMerchantOrderCancellation(database, input);
    if (eligibility.error) return eligibility;
    const order = eligibility.order;
    if (eligibility.alreadyCancelled) return { orderId: order.id, status: "cancelled", idempotent: true };

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const updateResult = database.prepare(`
      UPDATE orders SET status = 'cancelled', pickup_status = 'cancelled',
        merchant_acceptance_status = 'cancelled', updated_at = ?
      WHERE id = ?
        AND status != 'cancelled'
        AND payment_status NOT IN ('captured', 'refunded')
    `).run(now, order.id);
    if (updateResult.changes !== 1) {
      const currentOrder = database.prepare("SELECT status, payment_status FROM orders WHERE id = ?").get(order.id);
      database.exec("ROLLBACK;");
      transactionStarted = false;
      if (currentOrder?.status === "cancelled") {
        return { orderId: order.id, status: "cancelled", idempotent: true };
      }
      if (["captured", "refunded"].includes(currentOrder?.payment_status)) {
        return { error: "captured_order_cannot_be_cancelled" };
      }
      return { error: "order_state_changed", status: currentOrder?.status, paymentStatus: currentOrder?.payment_status };
    }
    const pendingAuthorizations = database.prepare(`
      SELECT id, status FROM payment_authorizations WHERE order_id = ? AND status = 'pending'
    `).all(order.id);
    database.prepare(`
      UPDATE payment_authorizations SET status = 'failed', failure_reason = 'merchant_cancelled_group_buy_activity', updated_at = ?
      WHERE order_id = ? AND status = 'pending'
    `).run(now, order.id);
    database.prepare(`
      UPDATE order_revisions SET status = 'cancelled', failure_reason = 'merchant_cancelled_group_buy_activity',
        cancelled_at = ?, updated_at = ?
      WHERE order_id = ? AND status = 'pending_authorization'
    `).run(now, now, order.id);
    for (const authorization of pendingAuthorizations) {
      database.prepare(`
        INSERT INTO status_history (id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at)
        VALUES (?, 'payment_authorization', ?, ?, 'failed', 'merchant_cancelled_group_buy_activity', ?, ?)
      `).run(`status-history-${randomUUID()}`, authorization.id, authorization.status, input.actorUserId, now);
      database.prepare(`
        UPDATE payment_reliability_jobs
        SET status = 'cancelled', locked_by = NULL, locked_until = NULL, updated_at = ?, completed_at = ?
        WHERE job_type = 'reconcile_line_pay_request'
          AND resource_type = 'payment_authorization'
          AND resource_id = ?
          AND status IN ('queued', 'running', 'retry_wait')
      `).run(now, now, authorization.id);
    }
    database.prepare(`
      INSERT INTO status_history (id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at)
      VALUES (?, 'order', ?, ?, 'cancelled', ?, ?, ?)
    `).run(`status-history-${randomUUID()}`, order.id, order.status, input.reason, input.actorUserId, now);
    database.prepare(`
      INSERT INTO audit_logs (id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at)
      VALUES (?, ?, 'merchant_cancel_order', 'order', ?, ?, ?)
    `).run(`audit-log-${randomUUID()}`, input.actorUserId, order.id, JSON.stringify({ reason: input.reason, activityId: input.activityId }), now);
    result = { orderId: order.id, status: "cancelled", idempotent: false };
    if (input.idempotencyKey) database.prepare(`
      INSERT INTO order_action_idempotency (idempotency_key, order_id, action_type, actor_user_id, result_json, created_at)
      VALUES (?, ?, 'merchant_cancel_order', ?, ?, ?)
    `).run(input.idempotencyKey, order.id, input.actorUserId, JSON.stringify(result), now);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
  return result;
}

function listCustomerOrders(customerUserId, input = {}) {
  return listOrdersWithContext({ ...input, customerUserId, role: "customer" });
}

function listMerchantStoreOrders(storeId, input = {}) {
  return listOrdersWithContext({ ...input, storeId, role: "merchant" });
}

function listOrdersWithContext(input = {}) {
  const activityById = new Map(listGroupBuyActivities().map((activity) => [activity.id, activity]));
  const database = openDatabase();
  const scope = input.scope === "history" ? "history" : "active";
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  const cursor = decodeOrderListCursor(input.cursor);
  const now = input.now || new Date().toISOString();
  try {
    const rows = database.prepare(`
      SELECT orders.id,
             orders.submitted_at,
             activity.id AS activity_id,
             activity.title AS activity_title,
             activity.status AS activity_status,
             activity.deadline_at,
             activity.pickup_start_at,
             activity.pickup_end_at,
             activity.withdrawal_lock_minutes,
             store.id AS store_id,
             store.name AS store_name,
             store.address AS store_address,
             '匿名顧客' AS customer_alias,
             credential.id AS pickup_credential_id,
             CASE
               WHEN credential.redeemed_at IS NOT NULL THEN 'redeemed'
               WHEN credential.expired_at IS NOT NULL THEN 'expired'
               WHEN credential.id IS NOT NULL THEN 'active'
               ELSE NULL
             END AS pickup_credential_status,
             credential.expires_at AS pickup_credential_expires_at
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      JOIN stores store ON store.id = activity.store_id
      LEFT JOIN pickup_credentials credential ON credential.order_id = orders.id
      WHERE (? IS NULL OR orders.customer_user_id = ?)
        AND (? IS NULL OR activity.store_id = ?)
        AND (? IS NULL OR orders.activity_id = ?)
        AND (
          ? IS NULL
          OR orders.submitted_at < ?
          OR (orders.submitted_at = ? AND orders.id < ?)
        )
      ORDER BY orders.submitted_at DESC, orders.id DESC
    `).all(
      input.customerUserId || null,
      input.customerUserId || null,
      input.storeId || null,
      input.storeId || null,
      input.activityId || null,
      input.activityId || null,
      cursor?.submittedAt || null,
      cursor?.submittedAt || null,
      cursor?.submittedAt || null,
      cursor?.id || null
    );

    const matching = rows.map((row) => {
      const order = getOrderDetail(row.id);
      const activitySummary = activityById.get(row.activity_id);
      const context = {
        activity: activitySummary ?? {
          id: row.activity_id,
          title: row.activity_title,
          status: row.activity_status,
          deadlineAt: row.deadline_at,
          pickupStartAt: row.pickup_start_at,
          pickupEndAt: row.pickup_end_at,
          withdrawalLockMinutes: row.withdrawal_lock_minutes,
          storeId: row.store_id
        },
        store: { id: row.store_id, name: row.store_name, address: row.store_address },
        customer: input.role === "merchant" ? { alias: row.customer_alias || "匿名顧客" } : undefined,
        pickupCredential: row.pickup_credential_id ? {
          exists: true,
          status: row.pickup_credential_status,
          expiresAt: row.pickup_credential_expires_at
        } : { exists: false, status: null, expiresAt: null }
      };
      const lifecycleBucket = getOrderLifecycleBucket(order, context, now);
      return {
        ...order,
        ...context,
        lifecycleBucket,
        availableActions: getOrderAvailableActions(order, context, input.role, lifecycleBucket, now)
      };
    }).filter((order) => order.lifecycleBucket === scope);

    const page = matching.slice(0, limit);
    return {
      orders: page,
      nextCursor: matching.length > limit && page.length
        ? encodeOrderListCursor(page[page.length - 1])
        : null
    };
  } finally {
    database.close();
  }
}

function getOrderLifecycleBucket(order, context, now) {
  if (["cancelled", "completed"].includes(order.status)) return "history";
  if (["picked_up", "cancelled", "expired"].includes(order.pickupStatus)) return "history";
  if (["authorization_voided", "refunded"].includes(order.paymentStatus)) return "history";
  if (order.paymentStatus === "failed") {
    const cutoff = Date.parse(context.activity.pickupStartAt) - 15 * 60 * 1000;
    if (!Number.isNaN(cutoff) && Date.parse(now) >= cutoff) return "history";
  }
  return "active";
}

function getOrderAvailableActions(order, context, role, lifecycleBucket, now) {
  if (lifecycleBucket === "history") return [];
  const deadline = Date.parse(context.activity.deadlineAt);
  const lockMinutes = Number(context.activity.withdrawalLockMinutes || 30);
  const locked = !Number.isNaN(deadline) && deadline - Date.parse(now) <= lockMinutes * 60 * 1000;

  if (role === "customer") {
    return [...new Set(getCustomerOrderAvailableActions(order, context, locked))];
  }
  if (role === "merchant") {
    return [...new Set(getMerchantOrderAvailableActions(order, context))];
  }
  return [];
}

function getCustomerOrderAvailableActions(order, context, locked) {
  const actions = [];
  if (order.pendingRevision || (order.status === "submitted" && order.paymentStatus === "pending")) {
    actions.push("pay");
  }
  if (order.status === "submitted" && ["pending", "authorized"].includes(order.paymentStatus)) {
    // Editing stays available even once the withdrawal lock kicks in -- for an authorized order,
    // only decreasing total cups is blocked at write time (createOrderRevision), so a customer can
    // still top up in the last withdrawalLockMinutes before deadline. Pending orders have no
    // backend-enforced withdrawal lock at all (updateOrder/updatePostgresPendingOrder has no such
    // check), so they're never blocked here regardless of lock state.
    if (!order.pendingRevision) actions.push("edit");
    if (!locked) actions.push("cancel");
  }
  if (order.manualRepayment?.eligible) actions.push("repay");
  if (["ready", "picked_up"].includes(order.pickupStatus) && context.pickupCredential.exists) {
    actions.push("viewPickupCredential");
  }
  return actions;
}

function getMerchantOrderAvailableActions(order, context) {
  const actions = [];
  if (["ordering", "ready_for_pickup"].includes(context.activity.status)
    && order.paymentStatus === "captured"
    && order.pickupStatus === "not_ready") actions.push("markReadyForPickup");
  if (order.pickupStatus === "ready" && context.pickupCredential.status === "active") actions.push("redeemPickup");
  return actions;
}

function encodeOrderListCursor(order) {
  return Buffer.from(JSON.stringify({ submittedAt: order.submittedAt, id: order.id })).toString("base64url");
}

function decodeOrderListCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    return parsed?.submittedAt && parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

function getPendingOrderRevisionByOrderId(orderId) {
  const database = openDatabase();
  try {
    const revision = database.prepare(`
      SELECT id
      FROM order_revisions
      WHERE order_id = ?
        AND status = 'pending_authorization'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(orderId);

    return revision ? getOrderRevisionById(revision.id) : null;
  } finally {
    database.close();
  }
}

function createPendingLinePayAuthorization(input) {
  const database = openDatabase();
  const now = new Date().toISOString();
  const authorizationId = `payment-authorization-${randomUUID()}`;
  const provider = input.provider || "line_pay";
  const paymentFlow = input.paymentFlow || "authorization";
  let transactionStarted = false;

  try {
    const revision = input.orderRevisionId
      ? database.prepare(`
          SELECT id, order_id, status, original_amount
          FROM order_revisions
          WHERE id = ?
        `).get(input.orderRevisionId)
      : null;
    if (input.orderRevisionId && !revision) {
      return null;
    }
    if (revision && revision.status !== "pending_authorization") {
      return null;
    }

    const order = database.prepare(`
      SELECT id, original_amount, payment_status
      FROM orders
      WHERE id = ?
    `).get(revision?.order_id || input.orderId);

    if (!order) {
      return null;
    }
    if (revision && input.orderId && revision.order_id !== input.orderId) {
      return null;
    }

    const existingAuthorization = input.providerTransactionId
      ? database.prepare(`
          SELECT *
          FROM payment_authorizations
          WHERE provider = ?
            AND provider_authorization_id = ?
          LIMIT 1
        `).get(provider, input.providerTransactionId)
      : null;

    if (existingAuthorization) {
      return mapPaymentAuthorization(existingAuthorization);
    }

    database.exec("BEGIN;");
    transactionStarted = true;
    database.prepare(`
      INSERT INTO payment_authorizations (
        id,
        order_id,
        order_revision_id,
        provider,
        payment_flow,
        status,
        original_amount,
        authorized_amount,
        provider_authorization_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)
    `).run(
      authorizationId,
      revision?.order_id || input.orderId,
      revision?.id || null,
      provider,
      paymentFlow,
      revision?.original_amount ?? input.amount,
      input.providerTransactionId,
      now,
      now
    );

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'payment_authorization', ?, NULL, 'pending', ?, NULL, ?)
    `).run(
      `status-history-${randomUUID()}`,
      authorizationId,
      paymentFlow === "direct_repayment"
        ? "line_pay_direct_repayment_request_created"
        : "line_pay_request_created",
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, NULL, ?, 'payment_authorization', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      paymentFlow === "direct_repayment"
        ? "line_pay_request_direct_repayment"
        : "line_pay_request_authorization",
      authorizationId,
      JSON.stringify({
        orderId: revision?.order_id || input.orderId,
        orderRevisionId: revision?.id || null,
        paymentFlow,
        providerTransactionId: input.providerTransactionId
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return getPaymentAuthorizationById(authorizationId);
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function completeManualLinePayRepaymentInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const captureId = `payment-capture-${randomUUID()}`;
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) return null;
    if (authorization.payment_flow !== "direct_repayment") {
      return {
        error: "payment_flow_mismatch",
        authorization: mapPaymentAuthorization(authorization)
      };
    }
    if (authorization.status === "captured") {
      const existingCapture = database.prepare(`
        SELECT * FROM payment_captures
        WHERE payment_authorization_id = ? AND status = 'captured'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(authorization.id);
      return {
        authorization: mapPaymentAuthorization(authorization),
        capture: existingCapture ? mapPaymentCapture(existingCapture) : null,
        status: "captured"
      };
    }
    if (authorization.status !== "pending") {
      return {
        error: "repayment_not_pending",
        authorization: mapPaymentAuthorization(authorization)
      };
    }

    const order = database.prepare(`
      SELECT orders.*, activity.status AS activity_status
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE orders.id = ?
    `).get(authorization.order_id);
    if (!order) return null;

    const amount = Number(input.amount ?? authorization.original_amount);
    if (!Number.isInteger(amount) || amount <= 0 || amount !== authorization.original_amount) {
      return {
        error: "repayment_amount_mismatch",
        expectedAmount: authorization.original_amount,
        requestedAmount: amount,
        authorization: mapPaymentAuthorization(authorization)
      };
    }
    if (order.payment_status === "captured") {
      return {
        error: "already_paid",
        authorization: mapPaymentAuthorization(authorization)
      };
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const updateAuthorization = database.prepare(`
      UPDATE payment_authorizations
      SET status = 'captured',
          authorized_amount = ?,
          authorized_at = ?,
          failure_reason = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'pending'
    `).run(amount, now, now, authorization.id);
    if (updateAuthorization.changes !== 1) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return {
        error: "repayment_state_changed",
        authorization: getPaymentAuthorizationById(authorization.id)
      };
    }

    database.prepare(`
      INSERT INTO payment_captures (
        id,
        payment_authorization_id,
        order_id,
        status,
        final_amount,
        capture_amount,
        released_amount,
        provider_capture_id,
        captured_at,
        attempt_number,
        retryable,
        next_retry_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'captured', ?, ?, 0, ?, ?, 1, 0, NULL, ?, ?)
    `).run(
      captureId,
      authorization.id,
      authorization.order_id,
      amount,
      amount,
      input.providerCaptureId || input.providerTransactionId || authorization.provider_authorization_id,
      now,
      now,
      now
    );

    database.prepare(`
      UPDATE orders
      SET payment_status = 'captured',
          authorization_status = 'captured',
          final_amount = ?,
          merchant_acceptance_status = 'accepted',
          pickup_status = CASE WHEN pickup_status = 'cancelled' THEN pickup_status ELSE 'not_ready' END,
          updated_at = ?
      WHERE id = ?
        AND payment_status != 'captured'
    `).run(amount, now, authorization.order_id);

    const activityUpdate = database.prepare(`
      UPDATE group_buy_activities
      SET status = 'ordering',
          updated_at = ?
      WHERE id = ?
        AND status = 'failed'
    `).run(now, order.activity_id);

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'capture', ?, 'manual_repayment_confirmed', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.provider,
      captureId,
      authorization.provider_authorization_id
        ? `${authorization.provider}_manual_repayment_confirmed:${authorization.provider_authorization_id}`
        : null,
      JSON.stringify({
        orderId: authorization.order_id,
        amount,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO status_history (
        id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
      ) VALUES (?, 'payment_authorization', ?, 'pending', 'captured', 'manual_repayment_confirmed', NULL, ?)
    `).run(`status-history-${randomUUID()}`, authorization.id, now);

    if (activityUpdate.changes === 1) {
      database.prepare(`
        INSERT INTO status_history (
          id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
        ) VALUES (?, 'activity', ?, 'failed', 'ordering', 'manual_repayment_received', NULL, ?)
      `).run(`status-history-${randomUUID()}`, order.activity_id, now);
    }

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, NULL, 'line_pay_manual_repayment_captured', 'order', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      authorization.order_id,
      JSON.stringify({
        paymentAuthorizationId: authorization.id,
        captureId,
        amount,
        providerTransactionId: authorization.provider_authorization_id
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      authorization: getPaymentAuthorizationById(authorization.id),
      capture: getPaymentCaptureById(captureId),
      order: getOrderDetail(authorization.order_id),
      status: "captured"
    };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function createPendingLinePayRefundInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const provider = input.provider || "line_pay";
  const refundId = `payment-refund-${randomUUID()}`;
  const reason = input.reason || "line_pay_refund_requested";
  const requestedRefundAmount = input.refundAmount ?? input.amount;
  let transactionStarted = false;

  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const rollback = (payload) => {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return payload;
    };

    const capturedPayment = findRefundablePaymentCapture(database, input, provider);
    if (!capturedPayment) {
      return rollback({ error: "captured_payment_not_found" });
    }

    const refundedAmount = getRefundedAmountForCapture(database, capturedPayment.capture_id);
    const remainingRefundableAmount = Math.max(capturedPayment.capture_amount - refundedAmount, 0);
    const refundAmount = requestedRefundAmount == null
      ? remainingRefundableAmount
      : Number(requestedRefundAmount);
    const idempotencyKey = normalizeRefundIdempotencyKey(input.idempotencyKey)
      || buildDefaultRefundIdempotencyKey({
        provider,
        providerTransactionId: capturedPayment.provider_authorization_id,
        captureId: capturedPayment.capture_id,
        refundAmount,
        fullRefund: requestedRefundAmount == null
      });

    const existingRefund = database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE idempotency_key = ?
    `).get(idempotencyKey);
    if (existingRefund) {
      return rollback({
        refund: mapPaymentRefund(existingRefund),
        alreadyExists: true,
        capture: mapRefundableCaptureRow(capturedPayment),
        authorization: mapRefundableAuthorizationRow(capturedPayment),
        order: mapRefundableOrderRow(capturedPayment),
        remainingRefundableAmount,
        totalRefundedAmount: refundedAmount
      });
    }

    if (remainingRefundableAmount <= 0) {
      const latestRefund = database.prepare(`
        SELECT *
        FROM payment_refunds
        WHERE payment_capture_id = ?
          AND status = 'refunded'
        ORDER BY refunded_at DESC, created_at DESC, id DESC
        LIMIT 1
      `).get(capturedPayment.capture_id);
      return rollback({
        error: "already_fully_refunded",
        refund: latestRefund ? mapPaymentRefund(latestRefund) : null,
        capture: mapRefundableCaptureRow(capturedPayment),
        authorization: mapRefundableAuthorizationRow(capturedPayment),
        order: mapRefundableOrderRow(capturedPayment),
        remainingRefundableAmount: 0,
        totalRefundedAmount: refundedAmount
      });
    }

    if (!Number.isInteger(refundAmount) || refundAmount <= 0) {
      return rollback({
        error: "invalid_refund_amount",
        remainingRefundableAmount,
        requestedRefundAmount
      });
    }

    if (refundAmount > remainingRefundableAmount) {
      return rollback({
        error: "refund_amount_exceeds_remaining_amount",
        remainingRefundableAmount,
        requestedRefundAmount: refundAmount
      });
    }

    database.prepare(`
      INSERT INTO payment_refunds (
        id,
        payment_capture_id,
        payment_authorization_id,
        order_id,
        provider,
        status,
        refund_amount,
        idempotency_key,
        failure_reason,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      refundId,
      capturedPayment.capture_id,
      capturedPayment.authorization_id,
      capturedPayment.order_id,
      provider,
      refundAmount,
      idempotencyKey,
      reason,
      now,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'line_pay_refund_requested', 'payment_refund', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.actorUserId || null,
      refundId,
      JSON.stringify({
        orderId: capturedPayment.order_id,
        paymentCaptureId: capturedPayment.capture_id,
        paymentAuthorizationId: capturedPayment.authorization_id,
        providerTransactionId: capturedPayment.provider_authorization_id,
        refundAmount,
        remainingRefundableAmount,
        reason,
        idempotencyKey
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      refund: getPaymentRefundById(refundId),
      alreadyExists: false,
      capture: mapRefundableCaptureRow(capturedPayment),
      authorization: mapRefundableAuthorizationRow(capturedPayment),
      order: mapRefundableOrderRow(capturedPayment),
      remainingRefundableAmount,
      totalRefundedAmount: refundedAmount
    };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function completeLinePayRefundInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  let transactionStarted = false;

  try {
    const refund = database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE id = ?
    `).get(input.refundId);
    if (!refund) return null;
    if (refund.status === "refunded") {
      return buildRefundResult(database, refund);
    }
    if (refund.status !== "pending") {
      return {
        error: "refund_not_pending",
        refund: mapPaymentRefund(refund)
      };
    }

    const capture = database.prepare(`
      SELECT *
      FROM payment_captures
      WHERE id = ?
    `).get(refund.payment_capture_id);
    if (!capture || capture.status !== "captured") {
      return {
        error: "capture_not_refundable",
        refund: mapPaymentRefund(refund)
      };
    }

    const order = database.prepare(`
      SELECT *
      FROM orders
      WHERE id = ?
    `).get(refund.order_id);
    if (!order) return null;

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const updateRefund = database.prepare(`
      UPDATE payment_refunds
      SET status = 'refunded',
          provider_refund_id = ?,
          refunded_at = ?,
          failure_reason = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'pending'
    `).run(
      input.providerRefundId || null,
      now,
      now,
      refund.id
    );
    if (updateRefund.changes !== 1) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return buildRefundResult(database, database.prepare(`
        SELECT *
        FROM payment_refunds
        WHERE id = ?
      `).get(refund.id));
    }

    const totalRefundedAmount = getRefundedAmountForCapture(database, capture.id);
    const remainingRefundableAmount = Math.max(capture.capture_amount - totalRefundedAmount, 0);
    const fullyRefunded = remainingRefundableAmount === 0;

    if (fullyRefunded) {
      const updateOrder = database.prepare(`
        UPDATE orders
        SET payment_status = 'refunded',
            updated_at = ?
        WHERE id = ?
          AND payment_status != 'refunded'
      `).run(now, refund.order_id);

      if (updateOrder.changes === 1) {
        database.prepare(`
          INSERT INTO status_history (
            id, resource_type, resource_id, from_status, to_status, reason, actor_user_id, created_at
          ) VALUES (?, 'order', ?, ?, 'refunded', 'line_pay_refund_completed', ?, ?)
        `).run(
          `status-history-${randomUUID()}`,
          refund.order_id,
          order.payment_status,
          input.actorUserId || null,
          now
        );
      }
    }

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'refund', ?, 'refund_success', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      refund.provider,
      refund.id,
      refund.idempotency_key ? `${refund.provider}_refund_success:${refund.idempotency_key}` : null,
      JSON.stringify({
        orderId: refund.order_id,
        paymentCaptureId: refund.payment_capture_id,
        paymentAuthorizationId: refund.payment_authorization_id,
        refundAmount: refund.refund_amount,
        providerRefundId: input.providerRefundId || null,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'line_pay_refund_completed', 'payment_refund', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.actorUserId || null,
      refund.id,
      JSON.stringify({
        orderId: refund.order_id,
        paymentCaptureId: refund.payment_capture_id,
        paymentAuthorizationId: refund.payment_authorization_id,
        refundAmount: refund.refund_amount,
        totalRefundedAmount,
        remainingRefundableAmount,
        fullyRefunded,
        providerRefundId: input.providerRefundId || null
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return buildRefundResult(database, database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE id = ?
    `).get(refund.id));
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function failLinePayRefundInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const reason = input.reason || "line_pay_refund_failed";
  let transactionStarted = false;

  try {
    const refund = database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE id = ?
    `).get(input.refundId);
    if (!refund) return null;
    if (refund.status !== "pending") {
      return buildRefundResult(database, refund);
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    database.prepare(`
      UPDATE payment_refunds
      SET status = 'failed',
          failure_reason = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'pending'
    `).run(reason, now, refund.id);

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'refund', ?, 'refund_failed', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      refund.provider,
      refund.id,
      refund.idempotency_key ? `${refund.provider}_refund_failed:${refund.idempotency_key}` : null,
      JSON.stringify({
        orderId: refund.order_id,
        paymentCaptureId: refund.payment_capture_id,
        paymentAuthorizationId: refund.payment_authorization_id,
        refundAmount: refund.refund_amount,
        reason,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'line_pay_refund_failed', 'payment_refund', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.actorUserId || null,
      refund.id,
      JSON.stringify({
        orderId: refund.order_id,
        paymentCaptureId: refund.payment_capture_id,
        paymentAuthorizationId: refund.payment_authorization_id,
        refundAmount: refund.refund_amount,
        reason,
        providerPayload: input.providerPayload || {}
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return buildRefundResult(database, database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE id = ?
    `).get(refund.id));
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function rejectLinePayAuthorizationAtConfirm(database, options) {
  const {
    authorization,
    revision,
    now,
    failureReason,
    providerTransactionId,
    providerPayload,
    setExpiresAt,
    expiresAtValue,
    eventType,
    eventPayloadExtra,
    auditActionType,
    auditMetadataExtra
  } = options;

  if (setExpiresAt) {
    database.prepare(`
      UPDATE payment_authorizations
      SET status = 'failed',
          expires_at = ?,
          failure_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(expiresAtValue, failureReason, now, authorization.id);
  } else {
    database.prepare(`
      UPDATE payment_authorizations
      SET status = 'failed',
          failure_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(failureReason, now, authorization.id);
  }

  if (revision) {
    database.prepare(`
      UPDATE order_revisions
      SET status = 'failed',
          failure_reason = ?,
          updated_at = ?,
          cancelled_at = ?
      WHERE id = ?
    `).run(failureReason, now, now, revision.id);
  }

  database.prepare(`
    INSERT INTO payment_provider_events (
      id,
      provider,
      resource_type,
      resource_id,
      event_type,
      idempotency_key,
      payload_json,
      received_at,
      processed_at
    ) VALUES (?, ?, 'authorization', ?, ?, ?, ?, ?, ?)
  `).run(
    `provider-event-${randomUUID()}`,
    authorization.provider,
    authorization.id,
    eventType,
    providerTransactionId ? `${authorization.provider}_${eventType}:${providerTransactionId}` : null,
    JSON.stringify({
      providerPayload: providerPayload || {},
      orderRevisionId: revision?.id || null,
      ...eventPayloadExtra
    }),
    now,
    now
  );

  database.prepare(`
    INSERT INTO status_history (
      id,
      resource_type,
      resource_id,
      from_status,
      to_status,
      reason,
      actor_user_id,
      created_at
    ) VALUES (?, 'payment_authorization', ?, ?, 'failed', ?, NULL, ?)
  `).run(
    `status-history-${randomUUID()}`,
    authorization.id,
    authorization.status,
    failureReason,
    now
  );

  database.prepare(`
    INSERT INTO audit_logs (
      id,
      actor_user_id,
      action_type,
      resource_type,
      resource_id,
      metadata_json,
      created_at
    ) VALUES (?, NULL, ?, 'payment_authorization', ?, ?, ?)
  `).run(
    `audit-log-${randomUUID()}`,
    auditActionType,
    authorization.id,
    JSON.stringify({
      orderId: authorization.order_id,
      orderRevisionId: revision?.id || null,
      providerTransactionId,
      ...auditMetadataExtra
    }),
    now
  );
}

function authorizeLinePayPaymentInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    if (authorization.status === "authorized") {
      return mapPaymentAuthorization(authorization);
    }

    if (authorization.status !== "pending") {
      return mapPaymentAuthorization(authorization);
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const order = database.prepare(`
      SELECT
        orders.id,
        orders.activity_id,
        orders.total_cups,
        orders.original_amount,
        activity.deadline_at,
        activity.maximum_cups
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE orders.id = ?
    `).get(authorization.order_id);

    if (!order) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return null;
    }

    const revision = authorization.order_revision_id
      ? database.prepare(`
          SELECT *
          FROM order_revisions
          WHERE id = ?
        `).get(authorization.order_revision_id)
      : null;
    if (authorization.order_revision_id && !revision) {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return {
        error: "order_revision_not_found",
        authorization: mapPaymentAuthorization(authorization)
      };
    }
    if (revision && revision.status !== "pending_authorization") {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return {
        error: "order_revision_not_pending",
        revision: mapOrderRevision(revision),
        authorization: mapPaymentAuthorization(authorization)
      };
    }

    const requestedCups = revision?.total_cups || order.total_cups;
    const requestedAmount = revision?.original_amount || order.original_amount;
    const authorizationExpiresAt = extractLinePayAuthorizationExpiresAt(input.providerPayload);
    const authorizationExpiryError = validateLinePayAuthorizationExpiry({
      provider: authorization.provider,
      expiresAt: authorizationExpiresAt,
      deadlineAt: order.deadline_at
    });
    const deadlineError = validateLinePayConfirmBeforeDeadline({
      now,
      deadlineAt: order.deadline_at
    });
    const authorizedCups = database.prepare(`
      SELECT COALESCE(SUM(total_cups), 0) AS cups
      FROM orders
      WHERE activity_id = ?
        AND id != ?
        AND payment_status IN ('authorized', 'captured')
        AND status NOT IN ('cancelled')
    `).get(order.activity_id, order.id).cups;

    if (deadlineError) {
      rejectLinePayAuthorizationAtConfirm(database, {
        authorization,
        revision,
        now,
        failureReason: deadlineError,
        providerTransactionId: input.providerTransactionId,
        providerPayload: input.providerPayload,
        setExpiresAt: true,
        expiresAtValue: authorizationExpiresAt,
        eventType: "confirm_deadline_rejected",
        eventPayloadExtra: { confirmAt: now, deadlineAt: order.deadline_at },
        auditActionType: "line_pay_confirm_deadline_rejected",
        auditMetadataExtra: { confirmAt: now, deadlineAt: order.deadline_at }
      });

      database.exec("COMMIT;");
      transactionStarted = false;

      return {
        error: deadlineError,
        confirmAt: now,
        deadlineAt: order.deadline_at,
        authorization: getPaymentAuthorizationById(authorization.id)
      };
    }

    if (authorizationExpiryError) {
      rejectLinePayAuthorizationAtConfirm(database, {
        authorization,
        revision,
        now,
        failureReason: authorizationExpiryError,
        providerTransactionId: input.providerTransactionId,
        providerPayload: input.providerPayload,
        setExpiresAt: true,
        expiresAtValue: authorizationExpiresAt,
        eventType: "confirm_expiry_rejected",
        eventPayloadExtra: {
          authorizationExpiresAt,
          deadlineAt: order.deadline_at,
          requiredExpiresAfter: getRequiredLinePayAuthorizationExpiry(order.deadline_at)
        },
        auditActionType: "line_pay_confirm_expiry_rejected",
        auditMetadataExtra: {
          authorizationExpiresAt,
          deadlineAt: order.deadline_at,
          requiredExpiresAfter: getRequiredLinePayAuthorizationExpiry(order.deadline_at)
        }
      });

      database.exec("COMMIT;");
      transactionStarted = false;

      return {
        error: authorizationExpiryError,
        authorizationExpiresAt,
        deadlineAt: order.deadline_at,
        requiredExpiresAfter: getRequiredLinePayAuthorizationExpiry(order.deadline_at),
        authorization: getPaymentAuthorizationById(authorization.id)
      };
    }

    if (order.maximum_cups && authorizedCups + requestedCups > order.maximum_cups) {
      rejectLinePayAuthorizationAtConfirm(database, {
        authorization,
        revision,
        now,
        failureReason: "capacity_exceeded_at_confirm",
        providerTransactionId: input.providerTransactionId,
        providerPayload: input.providerPayload,
        setExpiresAt: false,
        eventType: "confirm_capacity_rejected",
        eventPayloadExtra: { maximumCups: order.maximum_cups, authorizedCups, requestedCups },
        auditActionType: "line_pay_confirm_capacity_rejected",
        auditMetadataExtra: { maximumCups: order.maximum_cups, authorizedCups, requestedCups }
      });

      database.exec("COMMIT;");
      transactionStarted = false;

      return {
        error: "capacity_exceeded",
        maximumCups: order.maximum_cups,
        authorizedCups,
        requestedCups,
        authorization: getPaymentAuthorizationById(authorization.id)
      };
    }

    database.prepare(`
      UPDATE payment_authorizations
      SET status = 'authorized',
          authorized_amount = ?,
          expires_at = ?,
          authorized_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      input.amount,
      authorizationExpiresAt,
      now,
      now,
      authorization.id
    );

    let replacedAuthorization = null;
    if (revision) {
      replacedAuthorization = revision.original_payment_authorization_id
        ? database.prepare(`
            SELECT *
            FROM payment_authorizations
            WHERE id = ?
          `).get(revision.original_payment_authorization_id)
        : null;

      database.prepare(`
        DELETE FROM order_item_customizations
        WHERE order_item_id IN (
          SELECT id
          FROM order_items
          WHERE order_id = ?
        )
      `).run(authorization.order_id);
      database.prepare("DELETE FROM order_items WHERE order_id = ?").run(authorization.order_id);

      copyOrderRevisionItemsToOrder(database, revision.id, authorization.order_id);

      database.prepare(`
        UPDATE orders
        SET fallback_purchase_preference = ?,
            total_cups = ?,
            original_amount = ?,
            final_amount = NULL,
            payment_status = 'authorized',
            authorization_status = 'authorized',
            merchant_acceptance_status = 'accepted',
            pickup_status = 'not_ready',
            updated_at = ?
        WHERE id = ?
      `).run(
        revision.fallback_purchase_preference,
        revision.total_cups,
        revision.original_amount,
        now,
        authorization.order_id
      );

      database.prepare(`
        UPDATE order_revisions
        SET status = 'applied',
            replacement_payment_authorization_id = ?,
            applied_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        authorization.id,
        now,
        now,
        revision.id
      );
    } else {
      database.prepare(`
        UPDATE orders
        SET payment_status = 'authorized',
            authorization_status = 'authorized',
            merchant_acceptance_status = 'accepted',
            updated_at = ?
        WHERE id = ?
      `).run(now, authorization.order_id);
    }

    database.prepare(`
      INSERT INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'authorization', ?, 'confirm_success', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.provider,
      authorization.id,
      input.providerTransactionId ? `${authorization.provider}_confirm:${input.providerTransactionId}` : null,
      JSON.stringify({
        providerPayload: input.providerPayload || {},
        orderRevisionId: revision?.id || null
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'payment_authorization', ?, ?, 'authorized', 'line_pay_confirm_success', NULL, ?)
    `).run(
      `status-history-${randomUUID()}`,
      authorization.id,
      authorization.status,
      now
    );

    if (revision) {
      database.prepare(`
        INSERT INTO status_history (
          id,
          resource_type,
          resource_id,
          from_status,
          to_status,
          reason,
          actor_user_id,
          created_at
        ) VALUES (?, 'order', ?, 'submitted', 'submitted', 'order_revision_authorized_and_applied', NULL, ?)
      `).run(
        `status-history-${randomUUID()}`,
        authorization.order_id,
        now
      );

      database.prepare(`
        INSERT INTO audit_logs (
          id,
          actor_user_id,
          action_type,
          resource_type,
          resource_id,
          metadata_json,
          created_at
        ) VALUES (?, NULL, 'apply_order_revision_after_authorization', 'order', ?, ?, ?)
      `).run(
        `audit-log-${randomUUID()}`,
        authorization.order_id,
        JSON.stringify({
          orderRevisionId: revision.id,
          replacementPaymentAuthorizationId: authorization.id,
          originalPaymentAuthorizationId: revision.original_payment_authorization_id,
          previousTotalCups: revision.previous_total_cups,
          totalCups: revision.total_cups,
          previousOriginalAmount: revision.previous_original_amount,
          originalAmount: revision.original_amount
        }),
        now
      );
    }

    database.exec("COMMIT;");
    transactionStarted = false;

    const authorizedPayment = getPaymentAuthorizationById(authorization.id);
    if (!revision) {
      return authorizedPayment;
    }

    return {
      ...authorizedPayment,
      appliedOrderRevision: getOrderRevisionById(revision.id),
      replacedAuthorization: replacedAuthorization ? mapPaymentAuthorization(replacedAuthorization) : null
    };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function cancelPendingLinePayAuthorizationInDatabase(input) {
  const database = openDatabase();
  const now = new Date().toISOString();
  const reason = input.reason || "line_pay_cancel_redirect";
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    if (authorization.status !== "pending") {
      return mapPaymentAuthorization(authorization);
    }

    database.exec("BEGIN;");
    transactionStarted = true;

    database.prepare(`
      UPDATE payment_authorizations
      SET status = 'failed',
          failure_reason = ?,
          updated_at = ?
      WHERE id = ?
    `).run(reason, now, authorization.id);

    if (authorization.order_revision_id) {
      database.prepare(`
        UPDATE order_revisions
        SET status = 'failed',
            failure_reason = ?,
            cancelled_at = ?,
            updated_at = ?
        WHERE id = ?
          AND status = 'pending_authorization'
      `).run(reason, now, now, authorization.order_revision_id);
    }

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, 'line_pay', 'authorization', ?, 'cancel_redirect', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.id,
      input.providerTransactionId ? `line_pay_cancel:${input.providerTransactionId}` : null,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'payment_authorization', ?, 'pending', 'failed', ?, NULL, ?)
    `).run(
      `status-history-${randomUUID()}`,
      authorization.id,
      reason,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, NULL, 'line_pay_cancel_authorization', 'payment_authorization', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      authorization.id,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return getPaymentAuthorizationById(authorization.id);
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function voidLinePayAuthorizationInDatabase(input) {
  const database = openDatabase();
  const now = new Date().toISOString();
  const reason = input.reason || "line_pay_void_authorization";
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    if (authorization.status === "authorization_voided") {
      return mapPaymentAuthorization(authorization);
    }

    if (authorization.status === "captured") {
      return {
        error: "authorization_already_captured",
        authorization: mapPaymentAuthorization(authorization)
      };
    }

    database.exec("BEGIN;");
    transactionStarted = true;

    database.prepare(`
      UPDATE payment_authorizations
      SET status = 'authorization_voided',
          voided_at = ?,
          failure_reason = COALESCE(failure_reason, ?),
          updated_at = ?
      WHERE id = ?
    `).run(now, reason, now, authorization.id);

    database.prepare(`
      UPDATE orders
      SET payment_status = 'authorization_voided',
          authorization_status = 'authorization_voided',
          updated_at = ?
      WHERE id = ?
        AND payment_status != 'captured'
        AND NOT EXISTS (
          SELECT 1
          FROM payment_authorizations active_authorization
          WHERE active_authorization.order_id = ?
            AND active_authorization.id != ?
            AND active_authorization.status IN ('authorized', 'captured')
        )
    `).run(now, authorization.order_id, authorization.order_id, authorization.id);

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'authorization', ?, 'void_success', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.provider,
      authorization.id,
      input.providerTransactionId ? `${authorization.provider}_void:${input.providerTransactionId}` : null,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'payment_authorization', ?, ?, 'authorization_voided', ?, NULL, ?)
    `).run(
      `status-history-${randomUUID()}`,
      authorization.id,
      authorization.status,
      reason,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, NULL, 'line_pay_void_authorization', 'payment_authorization', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      authorization.id,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return getPaymentAuthorizationById(authorization.id);
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function recordLinePayVoidFailureInDatabase(input) {
  const database = openDatabase();
  const now = new Date().toISOString();
  const reason = input.reason || "line_pay_void_failed";
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    database.exec("BEGIN;");
    transactionStarted = true;

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'authorization', ?, 'void_failed', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.provider,
      authorization.id,
      input.providerTransactionId ? `${authorization.provider}_void_failed:${input.providerTransactionId}` : null,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, NULL, 'line_pay_void_authorization_failed', 'payment_authorization', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      authorization.id,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason,
        providerPayload: input.providerPayload || {}
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return mapPaymentAuthorization(authorization);
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function captureLinePayAuthorizationInDatabase(input) {
  const database = openDatabase();
  const now = new Date().toISOString();
  const captureAmount = Number(input.amount);
  const finalAmount = Number(input.finalAmount ?? input.amount);
  const reason = input.reason || "line_pay_capture_success";
  const captureId = `payment-capture-${randomUUID()}`;
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    if (authorization.status === "captured") {
      const latestCapture = getLatestPaymentCaptureByAuthorizationId(authorization.id);
      return {
        authorization: mapPaymentAuthorization(authorization),
        capture: latestCapture,
        status: "captured"
      };
    }

    if (authorization.status !== "authorized") {
      return {
        error: "authorization_not_capturable",
        status: authorization.status,
        authorization: mapPaymentAuthorization(authorization)
      };
    }

    if (!Number.isInteger(captureAmount) || captureAmount < 0) {
      return { error: "invalid_capture_amount" };
    }

    if (captureAmount > authorization.authorized_amount) {
      return {
        error: "capture_amount_exceeds_authorized_amount",
        authorizedAmount: authorization.authorized_amount,
        captureAmount
      };
    }

    database.exec("BEGIN;");
    transactionStarted = true;

    database.prepare(`
      INSERT INTO payment_captures (
        id,
        payment_authorization_id,
        order_id,
        status,
        final_amount,
        capture_amount,
        released_amount,
        provider_capture_id,
        captured_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'captured', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      captureId,
      authorization.id,
      authorization.order_id,
      finalAmount,
      captureAmount,
      Math.max(authorization.authorized_amount - captureAmount, 0),
      input.providerCaptureId || input.providerTransactionId || authorization.provider_authorization_id || null,
      now,
      now,
      now
    );

    database.prepare(`
      UPDATE payment_authorizations
      SET status = 'captured',
          updated_at = ?
      WHERE id = ?
    `).run(now, authorization.id);

    database.prepare(`
      UPDATE orders
      SET payment_status = 'captured',
          authorization_status = 'captured',
          final_amount = ?,
          updated_at = ?
      WHERE id = ?
    `).run(finalAmount, now, authorization.order_id);

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'capture', ?, 'capture_success', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.provider,
      captureId,
      input.providerTransactionId
        ? `${authorization.provider}_capture:${input.providerTransactionId}:${captureAmount}`
        : null,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO status_history (
        id,
        resource_type,
        resource_id,
        from_status,
        to_status,
        reason,
        actor_user_id,
        created_at
      ) VALUES (?, 'payment_authorization', ?, ?, 'captured', ?, NULL, ?)
    `).run(
      `status-history-${randomUUID()}`,
      authorization.id,
      authorization.status,
      reason,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, NULL, 'line_pay_capture_authorization', 'payment_authorization', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      authorization.id,
      JSON.stringify({
        captureId,
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        finalAmount,
        captureAmount,
        releasedAmount: Math.max(authorization.authorized_amount - captureAmount, 0),
        reason
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      authorization: getPaymentAuthorizationById(authorization.id),
      capture: getPaymentCaptureById(captureId),
      status: "captured"
    };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function recordLinePayCaptureFailureInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const captureAmount = Number(input.amount || 0);
  const finalAmount = Number(input.finalAmount ?? input.amount ?? 0);
  const reason = input.reason || "line_pay_capture_failed";
  const captureId = `payment-capture-${randomUUID()}`;
  const maxAttempts = normalizePositiveInteger(input.maxAttempts, 3);
  const retryIntervalMs = normalizePositiveInteger(input.retryIntervalMs, 30_000);
  let transactionStarted = false;

  try {
    const authorization = findLinePayAuthorization(database, input);
    if (!authorization) {
      return null;
    }

    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;

    const previousAttempts = database.prepare(`
      SELECT *
      FROM payment_captures
      WHERE payment_authorization_id = ?
        AND status = 'failed'
      ORDER BY created_at DESC, id DESC
    `).all(authorization.id);
    if (previousAttempts.length >= maxAttempts) {
      database.prepare(`
        UPDATE orders
        SET payment_status = 'failed',
            updated_at = ?
        WHERE id = ?
          AND payment_status != 'captured'
      `).run(now, authorization.order_id);
      database.exec("COMMIT;");
      transactionStarted = false;
      return {
        authorization: mapPaymentAuthorization(authorization),
        capture: previousAttempts[0] ? mapPaymentCapture(previousAttempts[0]) : null,
        status: "retry_exhausted",
        attemptCount: previousAttempts.length,
        maxAttempts,
        retryable: false,
        nextRetryAt: null
      };
    }

    const attemptNumber = previousAttempts.length + 1;
    const retryable = Boolean(input.retryable) && attemptNumber < maxAttempts;
    const nextRetryAt = retryable
      ? new Date(Date.parse(now) + retryIntervalMs).toISOString()
      : null;

    database.prepare(`
      INSERT INTO payment_captures (
        id,
        payment_authorization_id,
        order_id,
        status,
        final_amount,
        capture_amount,
        released_amount,
        provider_capture_id,
        failure_reason,
        attempt_number,
        retryable,
        next_retry_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'failed', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      captureId,
      authorization.id,
      authorization.order_id,
      Number.isInteger(finalAmount) && finalAmount >= 0 ? finalAmount : 0,
      Number.isInteger(captureAmount) && captureAmount >= 0 ? captureAmount : 0,
      input.providerCaptureId || input.providerTransactionId || authorization.provider_authorization_id || null,
      reason,
      attemptNumber,
      retryable ? 1 : 0,
      nextRetryAt,
      now,
      now
    );

    if (!retryable) {
      database.prepare(`
        UPDATE orders
        SET payment_status = 'failed',
            updated_at = ?
        WHERE id = ?
          AND payment_status != 'captured'
      `).run(now, authorization.order_id);
    }

    database.prepare(`
      INSERT OR IGNORE INTO payment_provider_events (
        id,
        provider,
        resource_type,
        resource_id,
        event_type,
        idempotency_key,
        payload_json,
        received_at,
        processed_at
      ) VALUES (?, ?, 'capture', ?, 'capture_failed', ?, ?, ?, ?)
    `).run(
      `provider-event-${randomUUID()}`,
      authorization.provider,
      captureId,
      input.providerTransactionId
        ? `${authorization.provider}_capture_failed:${input.providerTransactionId}:${captureAmount}:${attemptNumber}`
        : null,
      JSON.stringify({
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        reason,
        attemptNumber,
        maxAttempts,
        retryable,
        nextRetryAt,
        providerPayload: input.providerPayload || {}
      }),
      now,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id,
        actor_user_id,
        action_type,
        resource_type,
        resource_id,
        metadata_json,
        created_at
      ) VALUES (?, NULL, 'line_pay_capture_authorization_failed', 'payment_authorization', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      authorization.id,
      JSON.stringify({
        captureId,
        orderId: input.orderId || authorization.order_id,
        providerTransactionId: input.providerTransactionId || authorization.provider_authorization_id || null,
        finalAmount,
        captureAmount,
        reason,
        attemptNumber,
        maxAttempts,
        retryable,
        nextRetryAt,
        providerPayload: input.providerPayload || {}
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      authorization: mapPaymentAuthorization(authorization),
      capture: getPaymentCaptureById(captureId),
      status: retryable ? "retry_pending" : "retry_exhausted",
      attemptCount: attemptNumber,
      maxAttempts,
      retryable,
      nextRetryAt
    };
  } catch (error) {
    if (transactionStarted) {
      database.exec("ROLLBACK;");
    }
    throw error;
  } finally {
    database.close();
  }
}

function normalizeTiers(tiers) {
  const source = Array.isArray(tiers) && tiers.length > 0
    ? tiers
    : [{ targetCups: 20, discountPercent: 10 }];

  return source
    .map((tier) => ({
      targetCups: Number(tier.targetCups ?? tier.cups),
      discountPercent: Number(tier.discountPercent)
    }))
    .sort((left, right) => left.targetCups - right.targetCups);
}

function normalizePositiveInteger(value, fallback) {
  const numberValue = Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    return fallback;
  }
  return numberValue;
}

function calculatePickupExpirationAt(pickupStartAt, pickupEndAt) {
  const pickupStartTime = Date.parse(pickupStartAt);
  if (Number.isNaN(pickupStartTime)) return null;

  const threeHoursAfterPickupStart = pickupStartTime + 3 * 60 * 60 * 1000;
  const pickupEndTime = Date.parse(pickupEndAt);
  const expiresTime = Number.isNaN(pickupEndTime)
    ? threeHoursAfterPickupStart
    : Math.min(threeHoursAfterPickupStart, pickupEndTime);
  return new Date(expiresTime).toISOString();
}

function priceOrderItems(database, storeId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      error: "order_items_invalid",
      issues: [{ code: "items_required", field: "items" }]
    };
  }

  const issues = [];
  let priceChanged = false;
  const authoritativeItems = [];

  items.forEach((inputItem, index) => {
    const quantity = Number(inputItem.quantity);
    const menuItemId = String(inputItem.menuItemId ?? inputItem.drinkId ?? "").trim();
    if (!menuItemId) {
      issues.push({ code: "menu_item_required", itemIndex: index });
      return;
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      issues.push({ code: "quantity_invalid", itemIndex: index, menuItemId });
      return;
    }

    const menuItem = database.prepare(`
      SELECT id, store_id, name, base_price, is_available
      FROM menu_items
      WHERE id = ?
    `).get(menuItemId);
    if (!menuItem) {
      issues.push({ code: "menu_item_not_found", itemIndex: index, menuItemId });
      return;
    }
    if (menuItem.store_id !== storeId) {
      issues.push({ code: "menu_item_store_mismatch", itemIndex: index, menuItemId });
      return;
    }
    if (menuItem.is_available !== 1) {
      issues.push({ code: "menu_item_unavailable", itemIndex: index, menuItemId });
      return;
    }

    const options = database.prepare(`
      SELECT id, option_type, label, price_delta, sort_order
      FROM customization_options
      WHERE menu_item_id = ?
        AND is_available = 1
      ORDER BY option_type, sort_order, id
    `).all(menuItemId);
    const rules = database.prepare(`
      SELECT option_type, min_selections, max_selections
      FROM menu_item_customization_rules
      WHERE menu_item_id = ?
    `).all(menuItemId);
    const requestedOptionIds = normalizeRequestedCustomizationIds(inputItem, options, index, issues);
    const selectedOptions = [];

    for (const optionId of requestedOptionIds) {
      const option = options.find((item) => item.id === optionId);
      if (!option) {
        issues.push({ code: "customization_option_invalid", itemIndex: index, menuItemId, optionId });
        continue;
      }
      if (!selectedOptions.some((item) => item.id === option.id)) selectedOptions.push(option);
    }

    const groupTypes = new Set([
      ...options.map((option) => option.option_type),
      ...rules.map((rule) => rule.option_type)
    ]);
    for (const optionType of groupTypes) {
      const configuredRule = rules.find((rule) => rule.option_type === optionType);
      const defaultRule = defaultCustomizationRules[optionType] || { minSelections: 0, maxSelections: 1 };
      const minSelections = configuredRule?.min_selections ?? defaultRule.minSelections;
      const maxSelections = configuredRule?.max_selections ?? defaultRule.maxSelections;
      const selectedCount = selectedOptions.filter((option) => option.option_type === optionType).length;
      if (selectedCount < minSelections || selectedCount > maxSelections) {
        issues.push({
          code: "customization_selection_count_invalid",
          itemIndex: index,
          menuItemId,
          optionType,
          minSelections,
          maxSelections,
          selectedCount
        });
      }
    }

    const unitPrice = Number(menuItem.base_price)
      + selectedOptions.reduce((sum, option) => sum + Number(option.price_delta), 0);
    const subtotal = unitPrice * quantity;
    const submittedUnitPrice = inputItem.unitPrice ?? inputItem.price;
    const submittedSubtotal = inputItem.subtotal;
    if (submittedUnitPrice != null && Number(submittedUnitPrice) !== unitPrice) priceChanged = true;
    if (submittedSubtotal != null && Number(submittedSubtotal) !== subtotal) priceChanged = true;

    authoritativeItems.push({
      menuItemId,
      itemName: menuItem.name,
      quantity,
      unitPrice,
      subtotal,
      customizations: selectedOptions.map((option) => ({
        optionId: option.id,
        optionType: option.option_type,
        label: option.label,
        priceDelta: option.price_delta
      }))
    });
  });

  if (issues.length > 0) return { error: "order_items_invalid", issues };
  return { items: authoritativeItems, priceChanged };
}

function normalizeRequestedCustomizationIds(item, options, itemIndex, issues) {
  if (Array.isArray(item.customizationOptionIds)) {
    return [...new Set(item.customizationOptionIds.map((value) => String(value).trim()).filter(Boolean))];
  }

  const requestedLabels = [];
  for (const optionType of ["size", "sweetness", "ice"]) {
    const label = String(item[optionType] ?? "").trim();
    if (label) requestedLabels.push({ optionType, label });
  }
  for (const topping of Array.isArray(item.toppings) ? item.toppings : []) {
    const label = String(topping).trim();
    if (label && label !== "不加料") requestedLabels.push({ optionType: "topping", label });
  }

  const ids = [];
  for (const requested of requestedLabels) {
    const option = options.find((itemOption) => (
      itemOption.option_type === requested.optionType && itemOption.label === requested.label
    ));
    if (!option) {
      issues.push({
        code: "customization_option_invalid",
        itemIndex,
        optionType: requested.optionType,
        label: requested.label
      });
    } else {
      ids.push(option.id);
    }
  }
  return [...new Set(ids)];
}

function toAuthoritativeOrderItems(items) {
  return items.map((item) => ({
    menuItemId: item.menuItemId,
    itemName: item.itemName,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    subtotal: item.subtotal,
    customizationOptionIds: item.customizations.map((customization) => customization.optionId),
    customizations: item.customizations
  }));
}

function mapMenuItem(row, options, rules, includeUnavailable) {
  const optionTypeOrder = ["size", "sweetness", "ice", "topping"];
  const groupTypes = [...new Set([
    ...optionTypeOrder,
    ...rules.map((rule) => rule.option_type),
    ...options.map((option) => option.option_type)
  ])].filter((optionType) => (
    rules.some((rule) => rule.option_type === optionType)
    || options.some((option) => option.option_type === optionType)
  ));

  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    category: row.category,
    description: row.description,
    basePrice: row.base_price,
    isAvailable: row.is_available === 1,
    customizationGroups: groupTypes.map((optionType) => {
      const configuredRule = rules.find((rule) => rule.option_type === optionType);
      const fallback = defaultCustomizationRules[optionType] || { minSelections: 0, maxSelections: 1 };
      return {
        optionType,
        minSelections: configuredRule?.min_selections ?? fallback.minSelections,
        maxSelections: configuredRule?.max_selections ?? fallback.maxSelections,
        options: options
          .filter((option) => option.option_type === optionType)
          .filter((option) => includeUnavailable || option.is_available === 1)
          .map((option) => ({
            id: option.id,
            optionType,
            label: option.label,
            priceDelta: option.price_delta,
            isAvailable: option.is_available === 1
          }))
      };
    })
  };
}

function getOrderById(orderId) {
  const database = openDatabase();
  try {
    const order = database.prepare(`
      SELECT orders.*, customer.display_name AS customer_display_name
      FROM orders
      LEFT JOIN users customer ON customer.id = orders.customer_user_id
      WHERE orders.id = ?
    `).get(orderId);
    if (!order) return null;

    const items = database.prepare(`
      SELECT *
      FROM order_items
      WHERE order_id = ?
      ORDER BY rowid ASC
    `).all(orderId);
    const customizations = database.prepare(`
      SELECT *
      FROM order_item_customizations
      WHERE order_item_id = ?
      ORDER BY sort_order ASC
    `);

    return mapOrder(order, items.map((item) => ({
      ...item,
      customizations: customizations.all(item.id)
    })));
  } finally {
    database.close();
  }
}

function getPaymentAuthorizationById(authorizationId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE id = ?
    `).get(authorizationId);
    return row ? mapPaymentAuthorization(row) : null;
  } finally {
    database.close();
  }
}

function getPaymentCaptureById(captureId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM payment_captures
      WHERE id = ?
    `).get(captureId);
    return row ? mapPaymentCapture(row) : null;
  } finally {
    database.close();
  }
}

function getLatestPaymentCaptureByAuthorizationId(authorizationId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM payment_captures
      WHERE payment_authorization_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(authorizationId);
    return row ? mapPaymentCapture(row) : null;
  } finally {
    database.close();
  }
}

// Reads back the raw provider payload most recently recorded for a resource, so it can be
// reused later without a new column — see how authorizeLinePayPaymentInDatabase/
// voidLinePayAuthorizationInDatabase wrap providerPayload as
// payload_json = JSON.stringify({ providerPayload, ... }).
function getLatestPaymentProviderEventPayload({ resourceType, resourceId, eventType }) {
  const database = openDatabase();
  try {
    const row = eventType
      ? database.prepare(`
          SELECT payload_json
          FROM payment_provider_events
          WHERE resource_type = ?
            AND resource_id = ?
            AND event_type = ?
          ORDER BY received_at DESC
          LIMIT 1
        `).get(resourceType, resourceId, eventType)
      : database.prepare(`
          SELECT payload_json
          FROM payment_provider_events
          WHERE resource_type = ?
            AND resource_id = ?
          ORDER BY received_at DESC
          LIMIT 1
        `).get(resourceType, resourceId);

    if (!row?.payload_json) return null;
    const parsed = JSON.parse(row.payload_json);
    return parsed?.providerPayload ?? parsed;
  } finally {
    database.close();
  }
}

function getPaymentRefundById(refundId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE id = ?
    `).get(refundId);
    return row ? mapPaymentRefund(row) : null;
  } finally {
    database.close();
  }
}

function getPaymentRefundsByOrderId(orderId) {
  const database = openDatabase();
  try {
    return database.prepare(`
      SELECT *
      FROM payment_refunds
      WHERE order_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(orderId).map(mapPaymentRefund);
  } finally {
    database.close();
  }
}

function getActivitySettlementByActivityId(activityId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT *
      FROM activity_settlements
      WHERE activity_id = ?
    `).get(activityId);
    return row ? mapActivitySettlement(row) : null;
  } finally {
    database.close();
  }
}

function findLinePayAuthorization(database, input) {
  const provider = input.provider || "line_pay";

  if (input.providerTransactionId) {
    const byProviderTransaction = database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE provider = ?
        AND provider_authorization_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(provider, input.providerTransactionId);

    if (byProviderTransaction) {
      return byProviderTransaction;
    }
  }

  if (input.orderRevisionId) {
    return database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE provider = ?
        AND order_revision_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(provider, input.orderRevisionId);
  }

  if (input.orderId) {
    return database.prepare(`
      SELECT *
      FROM payment_authorizations
      WHERE provider = ?
        AND order_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(provider, input.orderId);
  }

  return null;
}

function findRefundablePaymentCapture(database, input, provider) {
  const baseQuery = `
    SELECT
      capture.id AS capture_id,
      capture.payment_authorization_id AS capture_payment_authorization_id,
      capture.order_id AS capture_order_id,
      capture.status AS capture_status,
      capture.final_amount AS capture_final_amount,
      capture.capture_amount AS capture_amount,
      capture.released_amount AS capture_released_amount,
      capture.provider_capture_id,
      capture.captured_at,
      authorization.id AS authorization_id,
      authorization.order_id AS authorization_order_id,
      authorization.provider,
      authorization.payment_flow,
      authorization.status AS authorization_status,
      authorization.original_amount,
      authorization.authorized_amount,
      authorization.provider_authorization_id,
      orders.id AS order_id,
      orders.customer_user_id,
      orders.payment_status AS order_payment_status,
      orders.authorization_status AS order_authorization_status,
      orders.final_amount AS order_final_amount
    FROM payment_captures capture
    JOIN payment_authorizations authorization
      ON authorization.id = capture.payment_authorization_id
    JOIN orders
      ON orders.id = capture.order_id
    WHERE capture.status = 'captured'
      AND authorization.provider = ?
  `;

  if (input.captureId) {
    return database.prepare(`${baseQuery} AND capture.id = ? LIMIT 1`).get(provider, input.captureId);
  }

  if (input.providerTransactionId) {
    return database.prepare(`
      ${baseQuery}
        AND authorization.provider_authorization_id = ?
      ORDER BY capture.captured_at DESC, capture.created_at DESC, capture.id DESC
      LIMIT 1
    `).get(provider, input.providerTransactionId);
  }

  if (input.orderId) {
    return database.prepare(`
      ${baseQuery}
        AND capture.order_id = ?
      ORDER BY capture.captured_at DESC, capture.created_at DESC, capture.id DESC
      LIMIT 1
    `).get(provider, input.orderId);
  }

  return null;
}

function getRefundedAmountForCapture(database, captureId) {
  const row = database.prepare(`
    SELECT COALESCE(SUM(refund_amount), 0) AS refunded_amount
    FROM payment_refunds
    WHERE payment_capture_id = ?
      AND status = 'refunded'
  `).get(captureId);
  return Number(row?.refunded_amount || 0);
}

function buildRefundResult(database, refund) {
  if (!refund) return null;
  const capture = database.prepare(`
    SELECT *
    FROM payment_captures
    WHERE id = ?
  `).get(refund.payment_capture_id);
  const totalRefundedAmount = getRefundedAmountForCapture(database, refund.payment_capture_id);
  const remainingRefundableAmount = capture
    ? Math.max(capture.capture_amount - totalRefundedAmount, 0)
    : 0;

  return {
    refund: mapPaymentRefund(refund),
    capture: capture ? mapPaymentCapture(capture) : null,
    order: getOrderDetail(refund.order_id),
    status: refund.status,
    fullyRefunded: capture ? remainingRefundableAmount === 0 : false,
    totalRefundedAmount,
    remainingRefundableAmount
  };
}

function normalizeRefundIdempotencyKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildDefaultRefundIdempotencyKey({
  provider,
  providerTransactionId,
  captureId,
  refundAmount,
  fullRefund
}) {
  const transactionPart = providerTransactionId || captureId;
  const amountPart = fullRefund ? "full" : `amount:${refundAmount}`;
  return `${provider}_refund:${transactionPart}:${amountPart}`;
}

function mapRefundableCaptureRow(row) {
  return {
    id: row.capture_id,
    paymentAuthorizationId: row.capture_payment_authorization_id,
    orderId: row.capture_order_id,
    status: row.capture_status,
    finalAmount: row.capture_final_amount,
    captureAmount: row.capture_amount,
    releasedAmount: row.capture_released_amount,
    providerCaptureId: row.provider_capture_id,
    capturedAt: row.captured_at
  };
}

function mapRefundableAuthorizationRow(row) {
  return {
    id: row.authorization_id,
    orderId: row.authorization_order_id,
    provider: row.provider,
    paymentFlow: row.payment_flow || "authorization",
    status: row.authorization_status,
    originalAmount: row.original_amount,
    authorizedAmount: row.authorized_amount,
    providerAuthorizationId: row.provider_authorization_id
  };
}

function mapRefundableOrderRow(row) {
  return {
    id: row.order_id,
    customerUserId: row.customer_user_id,
    paymentStatus: row.order_payment_status,
    authorizationStatus: row.order_authorization_status,
    finalAmount: row.order_final_amount
  };
}

function getOrderStoreId(orderId) {
  const database = openDatabase();
  try {
    const row = database.prepare(`
      SELECT activity.store_id AS store_id
      FROM orders
      JOIN group_buy_activities activity ON activity.id = orders.activity_id
      WHERE orders.id = ?
    `).get(orderId);
    return row?.store_id || null;
  } finally {
    database.close();
  }
}

function findLatestCapturedPaymentForOrder(database, orderId) {
  return database.prepare(`
    SELECT
      capture.id AS capture_id,
      capture.capture_amount,
      capture.status AS capture_status,
      orders.id AS order_id,
      orders.payment_status AS order_payment_status,
      activity.store_id AS store_id
    FROM payment_captures capture
    JOIN payment_authorizations authorization
      ON authorization.id = capture.payment_authorization_id
    JOIN orders
      ON orders.id = capture.order_id
    JOIN group_buy_activities activity
      ON activity.id = orders.activity_id
    WHERE capture.status = 'captured'
      AND capture.order_id = ?
    ORDER BY capture.captured_at DESC, capture.created_at DESC, capture.id DESC
    LIMIT 1
  `).get(orderId);
}

function mapRefundRequest(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    paymentCaptureId: row.payment_capture_id,
    storeId: row.store_id,
    requestedByUserId: row.requested_by_user_id,
    requestedAmount: row.requested_amount,
    reason: row.reason,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    resultingPaymentRefundId: row.resulting_payment_refund_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getRefundRequestById(requestId) {
  const database = openDatabase();
  try {
    const row = database.prepare("SELECT * FROM refund_requests WHERE id = ?").get(requestId);
    return row ? mapRefundRequest(row) : null;
  } finally {
    database.close();
  }
}

function listRefundRequestsForStore(storeId, { status } = {}) {
  const database = openDatabase();
  try {
    const rows = status
      ? database.prepare(`
          SELECT * FROM refund_requests
          WHERE store_id = ? AND status = ?
          ORDER BY created_at DESC
        `).all(storeId, status)
      : database.prepare(`
          SELECT * FROM refund_requests
          WHERE store_id = ?
          ORDER BY created_at DESC
        `).all(storeId);
    return rows.map(mapRefundRequest);
  } finally {
    database.close();
  }
}

function listRefundRequestsForAdmin({ status } = {}) {
  const database = openDatabase();
  try {
    const rows = status
      ? database.prepare(`
          SELECT * FROM refund_requests
          WHERE status = ?
          ORDER BY created_at DESC
        `).all(status)
      : database.prepare(`
          SELECT * FROM refund_requests
          ORDER BY created_at DESC
        `).all();
    return rows.map(mapRefundRequest);
  } finally {
    database.close();
  }
}

function createRefundRequestInDatabase(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const requestId = `refund-request-${randomUUID()}`;
  let transactionStarted = false;

  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const rollback = (payload) => {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return payload;
    };

    const capturedPayment = findLatestCapturedPaymentForOrder(database, input.orderId);
    if (!capturedPayment) {
      return rollback({ error: "captured_payment_not_found" });
    }
    if (input.storeId && capturedPayment.store_id !== input.storeId) {
      return rollback({ error: "order_store_mismatch" });
    }

    const idempotencyKey = normalizeRefundIdempotencyKey(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = database.prepare("SELECT * FROM refund_requests WHERE idempotency_key = ?").get(idempotencyKey);
      if (existing) {
        return rollback({ refundRequest: mapRefundRequest(existing), alreadyExists: true });
      }
    }

    const existingPending = database.prepare(`
      SELECT * FROM refund_requests
      WHERE payment_capture_id = ? AND status = 'pending'
      LIMIT 1
    `).get(capturedPayment.capture_id);
    if (existingPending) {
      return rollback({
        error: "refund_request_already_pending",
        refundRequest: mapRefundRequest(existingPending)
      });
    }

    const refundedAmount = getRefundedAmountForCapture(database, capturedPayment.capture_id);
    const remainingRefundableAmount = Math.max(capturedPayment.capture_amount - refundedAmount, 0);
    if (remainingRefundableAmount <= 0) {
      return rollback({ error: "already_fully_refunded", remainingRefundableAmount: 0 });
    }

    const requestedAmount = Number(input.requestedAmount);
    if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
      return rollback({ error: "invalid_refund_amount", remainingRefundableAmount });
    }
    if (requestedAmount > remainingRefundableAmount) {
      return rollback({ error: "refund_amount_exceeds_remaining_amount", remainingRefundableAmount });
    }

    const reason = (input.reason || "").trim();
    if (!reason) {
      return rollback({ error: "refund_reason_required" });
    }

    database.prepare(`
      INSERT INTO refund_requests (
        id, order_id, payment_capture_id, store_id, requested_by_user_id,
        requested_amount, reason, status, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      requestId,
      input.orderId,
      capturedPayment.capture_id,
      capturedPayment.store_id,
      input.actorUserId,
      requestedAmount,
      reason,
      idempotencyKey,
      now,
      now
    );

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'refund_request_created', 'refund_request', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      input.actorUserId || null,
      requestId,
      JSON.stringify({
        orderId: input.orderId,
        storeId: capturedPayment.store_id,
        paymentCaptureId: capturedPayment.capture_id,
        requestedAmount,
        remainingRefundableAmount,
        reason
      }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;

    return {
      refundRequest: getRefundRequestById(requestId),
      alreadyExists: false,
      remainingRefundableAmount: remainingRefundableAmount - requestedAmount
    };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function approveRefundRequestInDatabase({ requestId, resultingPaymentRefundId, actorUserId, now: nowInput }) {
  const database = openDatabase();
  const now = nowInput || new Date().toISOString();
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const existing = database.prepare("SELECT * FROM refund_requests WHERE id = ?").get(requestId);
    if (!existing || existing.status !== "pending") {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return existing ? mapRefundRequest(existing) : null;
    }

    database.prepare(`
      UPDATE refund_requests
      SET status = 'approved',
          reviewed_by_user_id = ?,
          reviewed_at = ?,
          resulting_payment_refund_id = ?,
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(actorUserId || null, now, resultingPaymentRefundId || null, now, requestId);

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'refund_request_approved', 'refund_request', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      actorUserId || null,
      requestId,
      JSON.stringify({ resultingPaymentRefundId: resultingPaymentRefundId || null }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;
    return getRefundRequestById(requestId);
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function rejectRefundRequestInDatabase({ requestId, rejectionReason, actorUserId, now: nowInput }) {
  const database = openDatabase();
  const now = nowInput || new Date().toISOString();
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const existing = database.prepare("SELECT * FROM refund_requests WHERE id = ?").get(requestId);
    if (!existing || existing.status !== "pending") {
      database.exec("ROLLBACK;");
      transactionStarted = false;
      return existing ? mapRefundRequest(existing) : null;
    }

    database.prepare(`
      UPDATE refund_requests
      SET status = 'rejected',
          reviewed_by_user_id = ?,
          reviewed_at = ?,
          rejection_reason = ?,
          updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(actorUserId || null, now, rejectionReason, now, requestId);

    database.prepare(`
      INSERT INTO audit_logs (
        id, actor_user_id, action_type, resource_type, resource_id, metadata_json, created_at
      ) VALUES (?, ?, 'refund_request_rejected', 'refund_request', ?, ?, ?)
    `).run(
      `audit-log-${randomUUID()}`,
      actorUserId || null,
      requestId,
      JSON.stringify({ rejectionReason }),
      now
    );

    database.exec("COMMIT;");
    transactionStarted = false;
    return getRefundRequestById(requestId);
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function mapOrderPaymentContext(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    customerUserId: row.customer_user_id,
    totalCups: row.total_cups,
    originalAmount: row.original_amount,
    paymentStatus: row.payment_status,
    authorizationStatus: row.authorization_status,
    deadlineAt: row.deadline_at
  };
}

function mapPaymentAuthorization(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    orderRevisionId: row.order_revision_id,
    provider: row.provider,
    paymentFlow: row.payment_flow || "authorization",
    status: row.status,
    originalAmount: row.original_amount,
    authorizedAmount: row.authorized_amount,
    providerAuthorizationId: row.provider_authorization_id,
    expiresAt: row.expires_at,
    authorizedAt: row.authorized_at,
    voidedAt: row.voided_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPaymentCapture(row) {
  return {
    id: row.id,
    paymentAuthorizationId: row.payment_authorization_id,
    orderId: row.order_id,
    status: row.status,
    finalAmount: row.final_amount,
    captureAmount: row.capture_amount,
    releasedAmount: row.released_amount,
    providerCaptureId: row.provider_capture_id,
    capturedAt: row.captured_at,
    failureReason: row.failure_reason,
    attemptNumber: row.attempt_number,
    retryable: Boolean(row.retryable),
    nextRetryAt: row.next_retry_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapPaymentRefund(row) {
  return {
    id: row.id,
    paymentCaptureId: row.payment_capture_id,
    paymentAuthorizationId: row.payment_authorization_id,
    orderId: row.order_id,
    provider: row.provider,
    status: row.status,
    refundAmount: row.refund_amount,
    providerRefundId: row.provider_refund_id,
    idempotencyKey: row.idempotency_key,
    refundedAt: row.refunded_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapActivitySettlement(row) {
  return {
    id: row.id,
    activityId: row.activity_id,
    outcome: row.outcome,
    authorizedCups: row.authorized_cups,
    appliedTierId: row.applied_tier_id,
    totalDiscountAmount: row.total_discount_amount,
    discountPercent: row.discount_percent,
    discountFunder: "merchant",
    calculationVersion: "percentage_v1",
    settledAt: row.settled_at,
    reason: row.reason
  };
}

function mapSettlementActivity(row) {
  return {
    id: row.id,
    status: row.status,
    deadlineAt: row.deadline_at,
    maximumCups: row.maximum_cups
  };
}

function mapSettlementTier(row) {
  return {
    id: row.id,
    targetCups: row.target_cups,
    discountPercent: row.discount_percent,
    sortOrder: row.sort_order
  };
}

// Computes THIS order's own discount from ITS OWN original_amount (see
// pricing/groupBuyDiscount.js's calculatePercentageDiscount) -- percentage discounts can't be
// pre-allocated per cup the way flat-amount tiers were, since two orders at the same tier can
// owe different discounts if their items are priced differently.
function mapSettlementOrder(row, context) {
  const appliedTier = context.appliedTier;
  const { finalAmount, discountAmount } = appliedTier
    ? calculatePercentageDiscount(row.original_amount, context.discountPercent)
    : { finalAmount: row.original_amount, discountAmount: 0 };
  const isAlreadyCaptured = row.payment_status === "captured";
  let action = "void";
  let actionReason = "discount_not_qualified";

  if (isAlreadyCaptured) {
    action = "already_captured";
    actionReason = "already_captured";
  } else if (!row.payment_authorization_id) {
    action = "error_missing_authorization";
    actionReason = "authorized_order_missing_authorization";
  } else if (context.outcome === "qualified") {
    action = "capture";
    actionReason = "discount_qualified";
  } else if (row.fallback_purchase_preference === "accept_original_price") {
    action = "capture";
    actionReason = "fallback_original_price_accepted";
  }

  return {
    id: row.id,
    activityId: row.activity_id,
    customerUserId: row.customer_user_id,
    paymentAuthorizationId: row.payment_authorization_id,
    paymentProvider: row.payment_provider,
    providerTransactionId: row.provider_authorization_id,
    paymentStatus: row.payment_status,
    orderStatus: row.status,
    fallbackPurchasePreference: row.fallback_purchase_preference,
    totalCups: row.total_cups,
    originalAmount: row.original_amount,
    discountAmount,
    authorizedAmount: row.authorized_amount,
    finalAmount,
    captureAmount: finalAmount,
    action,
    actionReason
  };
}

function extractLinePayAuthorizationExpiresAt(providerPayload) {
  const rawValue = providerPayload?.info?.authorizationExpireDate
    || providerPayload?.authorizationExpireDate
    || null;
  if (!rawValue) return null;

  const timestamp = Date.parse(rawValue);
  if (Number.isNaN(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function validateLinePayConfirmBeforeDeadline({ now, deadlineAt }) {
  const nowTime = Date.parse(now);
  const deadlineTime = Date.parse(deadlineAt);
  if (Number.isNaN(nowTime) || Number.isNaN(deadlineTime)) return null;
  return nowTime >= deadlineTime ? "authorization_confirmed_after_deadline" : null;
}

function validateLinePayAuthorizationExpiry({ provider, expiresAt, deadlineAt }) {
  if (provider !== "line_pay") return null;
  if (!readBooleanEnv(process.env.LINE_PAY_CAPTURE_SEPARATED, false)) return null;

  if (!expiresAt) return "authorization_expiry_missing";

  const expiresAtTime = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtTime)) return "authorization_expiry_invalid";

  const requiredExpiresAfter = getRequiredLinePayAuthorizationExpiry(deadlineAt);
  if (!requiredExpiresAfter) return null;

  if (expiresAtTime <= Date.parse(requiredExpiresAfter)) {
    return "authorization_expiry_too_short";
  }

  return null;
}

function getRequiredLinePayAuthorizationExpiry(deadlineAt) {
  const deadlineTime = Date.parse(deadlineAt);
  if (Number.isNaN(deadlineTime)) return null;

  const bufferMinutes = readPositiveIntegerEnv(
    process.env.LINE_PAY_AUTHORIZATION_SETTLEMENT_BUFFER_MINUTES,
    30
  );
  return new Date(deadlineTime + bufferMinutes * 60 * 1000).toISOString();
}

function readPositiveIntegerEnv(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readBooleanEnv(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function hydrateUserAuthProfile(database, user) {
  const roles = database.prepare(`
    SELECT role
    FROM user_roles
    WHERE user_id = ?
      AND status = 'active'
    ORDER BY role ASC
  `).all(user.id).map((row) => row.role);

  const merchantStores = database.prepare(`
    SELECT
      store.id,
      store.name,
      store.merchant_id,
      merchant_user.permission_level
    FROM merchant_users merchant_user
    JOIN stores store ON store.merchant_id = merchant_user.merchant_id
    WHERE merchant_user.user_id = ?
      AND merchant_user.status = 'active'
    ORDER BY store.name ASC
  `).all(user.id).map((row) => ({
    id: row.id,
    name: row.name,
    merchantId: row.merchant_id,
    permissionLevel: row.permission_level
  }));

  return {
    id: user.id,
    loginName: user.login_name,
    phoneNumber: user.phone_number,
    email: user.email,
    displayName: user.display_name,
    surname: user.surname,
    roles,
    merchantStores
  };
}

function toPublicUser(user) {
  return {
    id: user.id,
    loginName: user.loginName,
    phoneNumber: user.phoneNumber,
    email: user.email,
    displayName: user.displayName,
    surname: user.surname,
    roles: user.roles,
    merchantStores: user.merchantStores
  };
}

function toDevAuthUser(user) {
  const primaryRole = user.roles.includes("customer")
    ? "customer"
    : user.roles.includes("merchant")
      ? "merchant"
      : user.roles[0] || "unknown";
  const store = user.merchantStores?.[0] || null;

  return {
    ...toPublicUser(user),
    primaryRole,
    label: buildDevAuthUserLabel(user, primaryRole, store)
  };
}

function buildDevAuthUserLabel(user, primaryRole, store) {
  if (primaryRole === "customer") {
    return `顧客：${getReadableText(user.displayName) || user.loginName || user.id}`;
  }
  if (primaryRole === "merchant") {
    const storeLabel = getReadableText(store?.name) || store?.id;
    const accountLabel = getReadableText(user.loginName) || user.email || user.id;
    return `商家：${storeLabel || accountLabel}${storeLabel && accountLabel ? ` / ${accountLabel}` : ""}`;
  }
  if (primaryRole === "admin") {
    return "開發補救：管理員";
  }
  return getReadableText(user.displayName) || user.loginName || user.id;
}

function getReadableText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /^[?\s]+$/.test(text)) return null;
  return text;
}

function mapOrder(row, items = []) {
  return {
    id: row.id,
    activityId: row.activity_id,
    customerUserId: row.customer_user_id,
    customerDisplayName: row.customer_display_name,
    status: row.status,
    fallbackPurchasePreference: row.fallback_purchase_preference,
    totalCups: row.total_cups,
    originalAmount: row.original_amount,
    finalAmount: row.final_amount,
    paymentStatus: row.payment_status,
    authorizationStatus: row.authorization_status,
    merchantAcceptanceStatus: row.merchant_acceptance_status,
    pickupStatus: row.pickup_status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      menuItemId: item.menu_item_id,
      itemName: item.item_name_snapshot,
      quantity: item.quantity,
      unitPrice: item.unit_price_snapshot,
      subtotal: item.subtotal,
      customizations: (item.customizations || []).map((customization) => ({
        id: customization.id,
        customizationOptionId: customization.customization_option_id,
        optionType: customization.option_type,
        label: customization.label_snapshot,
        priceDelta: customization.price_delta_snapshot
      }))
    }))
  };
}

function mapOrderRevision(row, items = []) {
  return {
    id: row.id,
    orderId: row.order_id,
    status: row.status,
    originalPaymentAuthorizationId: row.original_payment_authorization_id,
    replacementPaymentAuthorizationId: row.replacement_payment_authorization_id,
    fallbackPurchasePreference: row.fallback_purchase_preference,
    previousTotalCups: row.previous_total_cups,
    previousOriginalAmount: row.previous_original_amount,
    totalCups: row.total_cups,
    originalAmount: row.original_amount,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    cancelledAt: row.cancelled_at,
    items: items.map((item) => ({
      id: item.id,
      menuItemId: item.menu_item_id,
      itemName: item.item_name_snapshot,
      quantity: item.quantity,
      unitPrice: item.unit_price_snapshot,
      subtotal: item.subtotal,
      customizations: (item.customizations || []).map((customization) => ({
        id: customization.id,
        customizationOptionId: customization.customization_option_id,
        optionType: customization.option_type,
        label: customization.label_snapshot,
        priceDelta: customization.price_delta_snapshot
      }))
    }))
  };
}

function enqueuePaymentReliabilityJob(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const runAfter = input.runAfter || now;
  const maxAttempts = normalizePositiveInteger(input.maxAttempts, 20);
  let transactionStarted = false;

  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const existing = database.prepare(`
      SELECT *
      FROM payment_reliability_jobs
      WHERE job_type = ?
        AND resource_type = ?
        AND resource_id = ?
        AND status IN ('queued', 'running', 'retry_wait')
      LIMIT 1
    `).get(input.jobType, input.resourceType, input.resourceId);

    if (existing) {
      database.prepare(`
        UPDATE payment_reliability_jobs
        SET payload_json = ?,
            max_attempts = CASE WHEN max_attempts < ? THEN ? ELSE max_attempts END,
            updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(input.payload || {}),
        maxAttempts,
        maxAttempts,
        now,
        existing.id
      );
      database.exec("COMMIT;");
      transactionStarted = false;
      return mapPaymentReliabilityJob(database.prepare(`
        SELECT * FROM payment_reliability_jobs WHERE id = ?
      `).get(existing.id));
    }

    const id = input.id || `payment-job-${randomUUID()}`;
    database.prepare(`
      INSERT INTO payment_reliability_jobs (
        id, job_type, resource_type, resource_id, status, payload_json,
        attempt_count, max_attempts, run_after, alert_required, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?, 0, ?, ?)
    `).run(
      id,
      input.jobType,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.payload || {}),
      maxAttempts,
      runAfter,
      now,
      now
    );
    database.exec("COMMIT;");
    transactionStarted = false;
    return mapPaymentReliabilityJob(database.prepare(`
      SELECT * FROM payment_reliability_jobs WHERE id = ?
    `).get(id));
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function claimPaymentReliabilityJobs(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const limit = Math.min(normalizePositiveInteger(input.limit, 10), 100);
  const leaseMs = Math.max(normalizePositiveInteger(input.leaseMs, 120_000), 1_000);
  const lockedUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  let transactionStarted = false;

  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    database.prepare(`
      UPDATE payment_reliability_jobs
      SET status = 'failed',
          locked_by = NULL,
          locked_until = NULL,
          alert_required = 1,
          last_error_json = ?,
          completed_at = ?,
          updated_at = ?
      WHERE status = 'running'
        AND locked_until <= ?
        AND attempt_count >= max_attempts
    `).run(JSON.stringify({ reason: "worker_lease_expired_after_final_attempt" }), now, now, now);
    const rows = database.prepare(`
      SELECT *
      FROM payment_reliability_jobs
      WHERE job_type = ?
        AND attempt_count < max_attempts
        AND (
          (status IN ('queued', 'retry_wait') AND run_after <= ?)
          OR (status = 'running' AND locked_until <= ?)
        )
      ORDER BY run_after ASC, created_at ASC
      LIMIT ?
    `).all(input.jobType, now, now, limit);

    const claimed = [];
    for (const row of rows) {
      const update = database.prepare(`
        UPDATE payment_reliability_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            locked_by = ?,
            locked_until = ?,
            updated_at = ?
        WHERE id = ?
          AND (
            (status IN ('queued', 'retry_wait') AND run_after <= ?)
            OR (status = 'running' AND locked_until <= ?)
          )
      `).run(input.workerId, lockedUntil, now, row.id, now, now);
      if (update.changes > 0) {
        claimed.push(database.prepare(`
          SELECT * FROM payment_reliability_jobs WHERE id = ?
        `).get(row.id));
      }
    }

    database.exec("COMMIT;");
    transactionStarted = false;
    return claimed.map(mapPaymentReliabilityJob);
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function completePaymentReliabilityJob(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  try {
    const update = database.prepare(`
      UPDATE payment_reliability_jobs
      SET status = 'succeeded',
          locked_by = NULL,
          locked_until = NULL,
          last_error_json = NULL,
          alert_required = 0,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
        AND status = 'running'
        AND locked_by = ?
    `).run(now, now, input.jobId, input.workerId);
    return update.changes > 0 ? getPaymentReliabilityJobById(database, input.jobId) : null;
  } finally {
    database.close();
  }
}

function reschedulePaymentReliabilityJob(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  try {
    const row = database.prepare(`
      SELECT * FROM payment_reliability_jobs
      WHERE id = ? AND status = 'running' AND locked_by = ?
    `).get(input.jobId, input.workerId);
    if (!row) return null;

    const terminal = Boolean(input.terminal) || row.attempt_count >= row.max_attempts;
    const nextStatus = terminal ? 'failed' : 'retry_wait';
    const completedAt = terminal ? now : null;
    const runAfter = input.runAfter || now;
    database.prepare(`
      UPDATE payment_reliability_jobs
      SET status = ?,
          run_after = ?,
          locked_by = NULL,
          locked_until = NULL,
          last_error_json = ?,
          alert_required = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ? AND locked_by = ?
    `).run(
      nextStatus,
      runAfter,
      JSON.stringify(input.error || {}),
      terminal ? 1 : 0,
      completedAt,
      now,
      input.jobId,
      input.workerId
    );
    return getPaymentReliabilityJobById(database, input.jobId);
  } finally {
    database.close();
  }
}

function getPaymentReliabilityJob(jobId) {
  const database = openDatabase();
  try {
    return getPaymentReliabilityJobById(database, jobId);
  } finally {
    database.close();
  }
}
function listPaymentReliabilityAlerts(input = {}) {
  const database = openDatabase();
  const limit = Math.min(normalizePositiveInteger(input.limit, 50), 200);
  try {
    return database.prepare(`
      SELECT *
      FROM payment_reliability_jobs
      WHERE alert_required = 1
        AND (? IS NULL OR job_type = ?)
        AND (? IS NULL OR status = ?)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(input.jobType || null, input.jobType || null, input.status || null, input.status || null, limit)
      .map(mapPaymentReliabilityJob);
  } finally {
    database.close();
  }
}


function listPendingLinePayAuthorizations(input = {}) {
  const database = openDatabase();
  const limit = Math.min(normalizePositiveInteger(input.limit, 100), 500);
  try {
    return database.prepare(`
      SELECT
        authorization.id,
        authorization.order_id,
        authorization.order_revision_id,
        authorization.provider_authorization_id,
        authorization.payment_flow,
        authorization.original_amount,
        authorization.created_at
      FROM payment_authorizations authorization
      WHERE authorization.provider = 'line_pay'
        AND authorization.status = 'pending'
        AND authorization.provider_authorization_id IS NOT NULL
      ORDER BY authorization.created_at ASC
      LIMIT ?
    `).all(limit).map((row) => ({
      id: row.id,
      orderId: row.order_id,
      orderRevisionId: row.order_revision_id,
      providerTransactionId: row.provider_authorization_id,
      paymentFlow: row.payment_flow || 'authorization',
      amount: row.original_amount,
      createdAt: row.created_at
    }));
  } finally {
    database.close();
  }
}

function acquireOperationLock(input) {
  const database = openDatabase();
  const now = input.now || new Date().toISOString();
  const leaseMs = Math.max(normalizePositiveInteger(input.leaseMs, 120_000), 1_000);
  const lockedUntil = new Date(Date.parse(now) + leaseMs).toISOString();
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE;");
    transactionStarted = true;
    const current = database.prepare(`
      SELECT * FROM operation_locks WHERE lock_key = ?
    `).get(input.lockKey);
    if (current && current.owner_id !== input.ownerId && current.locked_until > now) {
      database.exec("COMMIT;");
      transactionStarted = false;
      return { acquired: false, lockKey: input.lockKey, ownerId: current.owner_id, lockedUntil: current.locked_until };
    }

    database.prepare(`
      INSERT INTO operation_locks (lock_key, owner_id, locked_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lock_key) DO UPDATE SET
        owner_id = excluded.owner_id,
        locked_until = excluded.locked_until,
        updated_at = excluded.updated_at
    `).run(input.lockKey, input.ownerId, lockedUntil, now, now);
    database.exec("COMMIT;");
    transactionStarted = false;
    return { acquired: true, lockKey: input.lockKey, ownerId: input.ownerId, lockedUntil };
  } catch (error) {
    if (transactionStarted) database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

function releaseOperationLock(input) {
  const database = openDatabase();
  try {
    return database.prepare(`
      DELETE FROM operation_locks WHERE lock_key = ? AND owner_id = ?
    `).run(input.lockKey, input.ownerId).changes > 0;
  } finally {
    database.close();
  }
}

function getPaymentReliabilityJobById(database, jobId) {
  return mapPaymentReliabilityJob(database.prepare(`
    SELECT * FROM payment_reliability_jobs WHERE id = ?
  `).get(jobId));
}

function mapPaymentReliabilityJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobType: row.job_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    status: row.status,
    payload: parseJsonObject(row.payload_json),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    runAfter: row.run_after,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    lastError: parseJsonObject(row.last_error_json),
    alertRequired: Boolean(row.alert_required),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

module.exports = {
  acquireOperationLock,
  approveRefundRequestInDatabase,
  authorizeLinePayPaymentInDatabase,
  claimPaymentReliabilityJobs,
  completePaymentReliabilityJob,
  createRefundRequestInDatabase,
  enqueuePaymentReliabilityJob,
  getOrderStoreId,
  getPaymentReliabilityJob,
  getRefundRequestById,
  listPendingLinePayAuthorizations,
  listPaymentReliabilityAlerts,
  listRefundRequestsForAdmin,
  listRefundRequestsForStore,
  rejectRefundRequestInDatabase,
  releaseOperationLock,
  reschedulePaymentReliabilityJob,
  calculatePickupExpirationAt,
  cancelPendingLinePayAuthorizationInDatabase,
  cancelGroupBuyActivity,
  cancelCustomerOrderInDatabase,
  cancelMerchantOrderInDatabase,
  getMerchantGroupBuyActivityForCancellation,
  listEligibleOrdersForMerchantCancellation,
  captureLinePayAuthorizationInDatabase,
  completeManualLinePayRepaymentInDatabase,
  completeLinePayRefundInDatabase,
  completeGroupBuySettlement,
  createGroupBuyActivity,
  createOrder,
  createGroupBuySettlementPlan,
  createOrderRevision,
  createPendingLinePayRefundInDatabase,
  createPendingLinePayAuthorization,
  expireGroupBuyPickupWindow,
  failLinePayRefundInDatabase,
  getLinePayAuthorizationContext,
  getOrderDetail,
  getCustomerOrderCancellationEligibility,
  getLatestLinePayAuthorizationForOrder,
  getLatestLinePayAuthorizationForOrderRevision,
  getLatestPaymentProviderEventPayload,
  getLinePayCaptureRetryState,
  getManualLinePayRepaymentContext,
  getOrderPaymentContext,
  getOrderRevisionById,
  getOrderRevisionPaymentContext,
  getUserAuthProfileByFirebaseUid,
  getUserAuthProfileById,
  listDevAuthUsers,
  listDueGroupBuyActivitiesForSettlement,
  listDueGroupBuyActivitiesForPickupExpiration,
  listGroupBuyActivities,
  listPublicStores,
  listCustomerOrders,
  listMerchantStoreOrders,
  listStoreMenu,
  openDatabase,
  recordLinePayCaptureFailureInDatabase,
  recordOrderRuleConsentInDatabase,
  recordLinePayVoidFailureInDatabase,
  saveMerchantMenuItem,
  toPublicUser,
  updatePendingOrder,
  voidLinePayAuthorizationInDatabase
};
