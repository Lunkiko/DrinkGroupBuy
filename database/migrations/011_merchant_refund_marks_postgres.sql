-- Scheme B self-reported refund (2026-10-21): merchant and customer settle the refund themselves,
-- the backend never calls a provider refund API, this just records what the merchant says happened.
-- Deliberately a separate table from refund_requests/payment_refunds: those two mean "waiting on a
-- provider response" (pending -> approved/refunded); a row here is a terminal fact the moment it's
-- written. Sharing a table would have meant changing that older pending/approved/rejected state
-- machine, which is still serving the existing admin-review backlog -- see docs/payment-rules-and-flow.md
-- "退款" for the full rule set.
--
-- A single order can have multiple rows (partial refunds marked one at a time); the sum of this
-- order's currently-`active` amounts must never exceed orders.final_amount. That sum is enforced in
-- the application transaction (with a row lock on the order, same pattern refundRequestService.js
-- already uses), not as a CHECK constraint, since a CHECK only ever sees the row being written, not
-- the other rows for the same order.
--
-- idempotency_key is scoped per merchant (UNIQUE (marked_by_user_id, idempotency_key)), not globally
-- unique like refund_requests.idempotency_key: a prior security review (docs/AI-security-review-log.md,
-- 2026-10-21) found a global key let one merchant's key collide with another merchant's row, requiring
-- the caller to re-verify the fetched row after every lookup. Scoping it here closes that bug class
-- structurally instead of relying on every caller remembering to re-check.

CREATE TABLE merchant_refund_marks (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  store_id text NOT NULL REFERENCES stores(id),
  marked_by_user_id text NOT NULL REFERENCES users(id),
  amount integer NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  idempotency_key text NOT NULL,
  revoked_at timestamptz,
  revoked_by_user_id text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT merchant_refund_marks_idempotency_key_unique UNIQUE (marked_by_user_id, idempotency_key),
  -- Keeps status and the revoke fields from ever drifting out of sync with each other, independent
  -- of whatever the application code does.
  CONSTRAINT merchant_refund_marks_revoked_fields_consistent CHECK (
    (status = 'revoked') = (revoked_at IS NOT NULL)
    AND (status = 'revoked') = (revoked_by_user_id IS NOT NULL)
  ),
  -- Data-integrity safety net only: this does NOT grant permission to revoke within 24 hours, it only
  -- guarantees a revoked row can never claim to have happened later than that. The "is this still
  -- within the 24-hour window right now" authorization check belongs in application code at request
  -- time (it depends on the current wall-clock time, which a CHECK constraint cannot reference).
  CONSTRAINT merchant_refund_marks_revoked_within_window CHECK (
    revoked_at IS NULL OR revoked_at <= created_at + interval '24 hours'
  )
);

-- The hottest query this table serves: "what's the active refund total for this order" runs on every
-- new mark's amount validation and every stats read. Indexing only the active rows keeps it from
-- scanning revoked history that no longer matters to either of those.
CREATE INDEX idx_merchant_refund_marks_order_active
  ON merchant_refund_marks(order_id)
  WHERE status = 'active';

CREATE INDEX idx_merchant_refund_marks_store ON merchant_refund_marks(store_id, status);
