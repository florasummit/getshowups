-- Stripe mode of each business's subscription, from the verified webhook event (event.livemode).
-- Revenue metrics count only live-mode subscriptions and payments, so Stripe test-mode records (everything
-- before STRIPE_LIVE_ENABLED) never appear as revenue after live billing is switched on. A subscription
-- without a row here is treated as test mode. Apply BEFORE setting STRIPE_LIVE_ENABLED=true.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS subscription_modes (
  customer   TEXT PRIMARY KEY REFERENCES customers(id),
  livemode   INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  updated_at INTEGER NOT NULL
);
