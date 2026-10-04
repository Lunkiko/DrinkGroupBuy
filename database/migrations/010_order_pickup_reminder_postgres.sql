-- Marks that a "your drink is still waiting, pickup closes soon" push notification has already been
-- sent for this order, so the reminder scheduler (backend/pickup/expirationService.js) sends it at
-- most once per order even though it runs every ~30 seconds and across several app instances.
--
-- NULL = no reminder sent yet. The scheduler claims orders with a single
-- UPDATE ... WHERE pickup_reminder_sent_at IS NULL ... RETURNING, so the claim itself is the dedup.
-- Nullable with no default and no CHECK: existing rows and every existing query are unaffected.
ALTER TABLE orders
  ADD COLUMN pickup_reminder_sent_at timestamptz;
