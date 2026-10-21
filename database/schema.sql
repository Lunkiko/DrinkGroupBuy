-- DrinkGroupBuy development database schema draft.
-- This is an implementation-oriented draft for local development, not a production migration history.
-- Naming follows AGENTS.md database-style snake_case.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  login_name TEXT UNIQUE,
  phone_number TEXT UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT,
  firebase_uid TEXT UNIQUE,
  display_name TEXT NOT NULL,
  surname TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_roles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('customer', 'merchant', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  granted_at TEXT NOT NULL,
  UNIQUE (user_id, role)
);

CREATE TABLE merchants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE merchant_users (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_level TEXT NOT NULL DEFAULT 'owner' CHECK (permission_level IN ('owner', 'manager', 'staff')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (merchant_id, user_id)
);

CREATE TABLE stores (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT,
  business_status TEXT NOT NULL DEFAULT 'open' CHECK (business_status IN ('open', 'closed', 'temporarily_closed')),
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  -- Daily closing time as "HH:MM" (24-hour), NULL = 24-hour store / not configured yet.
  -- Caps how late a merchant can set a group-buy's pickup start time -- the 3-hour pickup
  -- window (backend/pickup/pickupWindow.js) must fit entirely before closing.
  pickup_closing_time TEXT CHECK (pickup_closing_time IS NULL OR pickup_closing_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_stores_location ON stores(latitude, longitude);

CREATE TABLE menu_items (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  base_price INTEGER NOT NULL CHECK (base_price >= 0),
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE customization_options (
  id TEXT PRIMARY KEY,
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
  label TEXT NOT NULL,
  price_delta INTEGER NOT NULL DEFAULT 0 CHECK (price_delta >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_available INTEGER NOT NULL DEFAULT 1 CHECK (is_available IN (0, 1))
);

CREATE TABLE menu_item_customization_rules (
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
  min_selections INTEGER NOT NULL DEFAULT 0 CHECK (min_selections >= 0),
  max_selections INTEGER NOT NULL CHECK (max_selections >= min_selections),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (menu_item_id, option_type)
);

CREATE TABLE group_buy_activities (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recruiting'
    CHECK (status IN ('draft', 'recruiting', 'confirmed', 'failed', 'ordering', 'ready_for_pickup', 'completed', 'cancelled')),
  start_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  pickup_start_at TEXT NOT NULL,
  pickup_end_at TEXT NOT NULL,
  maximum_cups INTEGER,
  withdrawal_lock_minutes INTEGER NOT NULL DEFAULT 30,
  cancellation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_group_buy_activities_store_status ON group_buy_activities(store_id, status);
CREATE INDEX idx_group_buy_activities_deadline ON group_buy_activities(deadline_at);

CREATE TABLE promotion_tiers (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES group_buy_activities(id) ON DELETE CASCADE,
  target_cups INTEGER NOT NULL CHECK (target_cups > 0),
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 1 AND 99),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (activity_id, target_cups)
);

CREATE TABLE activity_notices (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES group_buy_activities(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cart_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES group_buy_activities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'submitted', 'expired', 'cancelled')),
  fallback_purchase_preference TEXT NOT NULL DEFAULT 'decline_original_price'
    CHECK (fallback_purchase_preference IN ('decline_original_price', 'accept_original_price')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, activity_id, status)
);

CREATE TABLE cart_draft_items (
  id TEXT PRIMARY KEY,
  cart_draft_id TEXT NOT NULL REFERENCES cart_drafts(id) ON DELETE CASCADE,
  menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
  item_name_snapshot TEXT NOT NULL,
  unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cart_draft_item_customizations (
  id TEXT PRIMARY KEY,
  cart_draft_item_id TEXT NOT NULL REFERENCES cart_draft_items(id) ON DELETE CASCADE,
  customization_option_id TEXT REFERENCES customization_options(id),
  option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
  label_snapshot TEXT NOT NULL,
  price_delta_snapshot INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES group_buy_activities(id),
  customer_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft', 'submitted', 'locked', 'cancelled', 'completed')),
  fallback_purchase_preference TEXT NOT NULL DEFAULT 'decline_original_price'
    CHECK (fallback_purchase_preference IN ('decline_original_price', 'accept_original_price')),
  total_cups INTEGER NOT NULL CHECK (total_cups > 0),
  original_amount INTEGER NOT NULL CHECK (original_amount >= 0),
  final_amount INTEGER,
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'authorized', 'captured', 'authorization_voided', 'failed', 'refunded')),
  authorization_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (authorization_status IN ('pending', 'authorized', 'captured', 'authorization_voided', 'failed')),
  merchant_acceptance_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (merchant_acceptance_status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  pickup_status TEXT NOT NULL DEFAULT 'not_ready'
    CHECK (pickup_status IN ('not_ready', 'ready', 'picked_up', 'cancelled', 'expired')),
  submitted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_orders_activity ON orders(activity_id);
CREATE INDEX idx_orders_customer ON orders(customer_user_id);
CREATE INDEX idx_orders_payment_status ON orders(payment_status);
CREATE UNIQUE INDEX idx_orders_one_active_per_customer_activity
ON orders(activity_id, customer_user_id)
WHERE status != 'cancelled';

CREATE TABLE order_rule_consents (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  customer_user_id TEXT NOT NULL REFERENCES users(id),
  rule_type TEXT NOT NULL CHECK (rule_type IN ('pickup_overdue')),
  rule_version TEXT NOT NULL,
  rule_content_snapshot TEXT NOT NULL,
  consented_at TEXT NOT NULL,
  UNIQUE (order_id, rule_type, rule_version)
);

CREATE INDEX idx_order_rule_consents_order ON order_rule_consents(order_id);
CREATE INDEX idx_order_rule_consents_customer ON order_rule_consents(customer_user_id);
CREATE INDEX idx_order_rule_consents_consented_at ON order_rule_consents(consented_at);

CREATE TABLE order_action_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id TEXT REFERENCES menu_items(id),
  item_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot >= 0),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0)
);

CREATE TABLE order_item_customizations (
  id TEXT PRIMARY KEY,
  order_item_id TEXT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  customization_option_id TEXT REFERENCES customization_options(id),
  option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
  label_snapshot TEXT NOT NULL,
  price_delta_snapshot INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE order_revisions (
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

CREATE INDEX idx_order_revisions_order ON order_revisions(order_id);
CREATE INDEX idx_order_revisions_status ON order_revisions(status);

CREATE TABLE order_revision_items (
  id TEXT PRIMARY KEY,
  order_revision_id TEXT NOT NULL REFERENCES order_revisions(id) ON DELETE CASCADE,
  menu_item_id TEXT REFERENCES menu_items(id),
  item_name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_snapshot INTEGER NOT NULL CHECK (unit_price_snapshot >= 0),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0)
);

CREATE TABLE order_revision_item_customizations (
  id TEXT PRIMARY KEY,
  order_revision_item_id TEXT NOT NULL REFERENCES order_revision_items(id) ON DELETE CASCADE,
  customization_option_id TEXT REFERENCES customization_options(id),
  option_type TEXT NOT NULL CHECK (option_type IN ('sweetness', 'ice', 'topping', 'size')),
  label_snapshot TEXT NOT NULL,
  price_delta_snapshot INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE payment_authorizations (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  order_revision_id TEXT REFERENCES order_revisions(id),
  provider TEXT NOT NULL CHECK (provider IN ('line_pay', 'mock_line_pay')),
  payment_flow TEXT NOT NULL DEFAULT 'authorization'
    CHECK (payment_flow IN ('authorization', 'direct_repayment')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'authorized', 'captured', 'authorization_voided', 'failed')),
  original_amount INTEGER NOT NULL CHECK (original_amount >= 0),
  authorized_amount INTEGER NOT NULL DEFAULT 0 CHECK (authorized_amount >= 0),
  provider_authorization_id TEXT,
  expires_at TEXT,
  authorized_at TEXT,
  voided_at TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payment_authorizations_order ON payment_authorizations(order_id);
CREATE INDEX idx_payment_authorizations_order_revision ON payment_authorizations(order_revision_id);

CREATE TABLE payment_captures (
  id TEXT PRIMARY KEY,
  payment_authorization_id TEXT NOT NULL REFERENCES payment_authorizations(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'captured', 'failed')),
  final_amount INTEGER NOT NULL CHECK (final_amount >= 0),
  capture_amount INTEGER NOT NULL CHECK (capture_amount >= 0),
  released_amount INTEGER NOT NULL DEFAULT 0 CHECK (released_amount >= 0),
  provider_capture_id TEXT,
  captured_at TEXT,
  failure_reason TEXT,
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  next_retry_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_payment_captures_authorization_attempt
ON payment_captures(payment_authorization_id, attempt_number);

CREATE TABLE payment_refunds (
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

CREATE INDEX idx_payment_refunds_capture ON payment_refunds(payment_capture_id);
CREATE INDEX idx_payment_refunds_order ON payment_refunds(order_id);

CREATE TABLE refund_requests (
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

CREATE INDEX idx_refund_requests_store ON refund_requests(store_id, status);
CREATE INDEX idx_refund_requests_order ON refund_requests(order_id);
CREATE UNIQUE INDEX idx_refund_requests_pending_per_capture
ON refund_requests(payment_capture_id)
WHERE status = 'pending';

-- Scheme B self-reported refund (2026-10-21): merchant and customer settle the refund themselves,
-- the backend never calls a provider refund API, this just records what the merchant says happened.
-- Deliberately a separate table from refund_requests/payment_refunds above: those two mean
-- "waiting on a provider response" (pending -> approved/refunded); a row here is a terminal fact
-- the moment it's written. Sharing a table would have meant changing that older pending/approved/
-- rejected state machine, which is still serving the existing admin-review backlog.
-- A single order can have multiple rows (partial refunds marked one at a time); the sum of this
-- order's currently-`active` amounts must never exceed orders.final_amount -- enforced in the
-- application transaction (with a row lock) rather than a CHECK, since a CHECK only ever sees the
-- row being written, not the other rows for the same order.
CREATE TABLE merchant_refund_marks (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  marked_by_user_id TEXT NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  -- Unlike refund_requests.idempotency_key (globally UNIQUE), this is scoped per merchant: a prior
  -- security review found a global key let one merchant's key collide with another's row, requiring
  -- the caller to re-verify after every lookup. Scoping it here closes that bug class structurally.
  idempotency_key TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (marked_by_user_id, idempotency_key),
  CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
    AND (status = 'revoked') = (revoked_by_user_id IS NOT NULL)
  )
);

CREATE INDEX idx_merchant_refund_marks_order_active
ON merchant_refund_marks(order_id)
WHERE status = 'active';

CREATE INDEX idx_merchant_refund_marks_store ON merchant_refund_marks(store_id, status);

CREATE TABLE payment_provider_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('authorization', 'capture', 'refund')),
  resource_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  payload_json TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE TABLE payment_reliability_jobs (
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

CREATE UNIQUE INDEX idx_payment_reliability_jobs_active_resource
ON payment_reliability_jobs(job_type, resource_type, resource_id)
WHERE status IN ('queued', 'running', 'retry_wait');

CREATE INDEX idx_payment_reliability_jobs_due
ON payment_reliability_jobs(job_type, status, run_after, locked_until);

CREATE TABLE operation_locks (
  lock_key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  locked_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_operation_locks_expiry ON operation_locks(locked_until);

CREATE TABLE activity_settlements (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL UNIQUE REFERENCES group_buy_activities(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('qualified', 'failed', 'cancelled')),
  authorized_cups INTEGER NOT NULL DEFAULT 0 CHECK (authorized_cups >= 0),
  applied_tier_id TEXT REFERENCES promotion_tiers(id),
  total_discount_amount INTEGER NOT NULL DEFAULT 0 CHECK (total_discount_amount >= 0),
  discount_percent INTEGER CHECK (discount_percent IS NULL OR discount_percent BETWEEN 1 AND 99),
  settled_at TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE pickup_credentials (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  pickup_code TEXT NOT NULL,
  visible_after_merchant_acceptance INTEGER NOT NULL DEFAULT 1 CHECK (visible_after_merchant_acceptance IN (0, 1)),
  expires_at TEXT NOT NULL,
  expired_at TEXT,
  redeemed_at TEXT,
  redeemed_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_pickup_credentials_expires_at ON pickup_credentials(expires_at);
CREATE UNIQUE INDEX idx_pickup_credentials_active_code
ON pickup_credentials(pickup_code)
WHERE redeemed_at IS NULL AND expired_at IS NULL;

CREATE TABLE status_history (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('activity', 'order', 'payment_authorization', 'pickup')),
  resource_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  actor_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_status_history_resource ON status_history(resource_type, resource_id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id),
  action_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
