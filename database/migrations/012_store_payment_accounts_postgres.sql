-- Multi-channel LINE Pay accounts (2026-10-22): each store gets its own payment-provider credentials
-- instead of every store sharing one platform-wide LINE_PAY_CHANNEL_ID/SECRET. This migration only
-- adds the table; backend/payments/linePayService.js resolves a store's row before calling LINE Pay,
-- see docs/payment-rules-and-flow.md for the long-term funding model this implements.
--
-- UNIQUE is on (store_id, provider), not store_id alone: a store can only have one row per provider
-- right now, but this leaves room for a second provider (e.g. a real 'line_pay' row alongside the
-- 'mock_line_pay' one, or a future credit-card provider) without a schema change later.
--
-- channel_secret is stored in plaintext here. That's acceptable for this feature's current scope
-- (mock accounts only, no real provider credentials) -- if real LINE Pay secrets are ever stored
-- here, this column needs encryption or a secret manager first, not a direct reuse of this table.

CREATE TABLE store_payment_accounts (
  id text PRIMARY KEY,
  store_id text NOT NULL REFERENCES stores(id),
  provider text NOT NULL CHECK (provider IN ('line_pay', 'mock_line_pay')),
  channel_id text NOT NULL,
  channel_secret text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_payment_accounts_store_provider_unique UNIQUE (store_id, provider)
);

-- The hot lookup: "give me this store's active account for this provider" on every LINE Pay call.
CREATE INDEX idx_store_payment_accounts_store_active
  ON store_payment_accounts(store_id, provider)
  WHERE status = 'active';
