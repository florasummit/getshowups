-- Business account classification (docs/ACCOUNT_TYPES.md). Additive and idempotent.
-- One row per business that is NOT an ordinary paying customer; no row = paying customer (the default, unchanged).
--   classification  internal_live  GetShowUps-owned business with real customers (e.g. PoolThru): complimentary
--                                  platform entitlement, production environment, excluded from paying/MRR counts.
--                   sandbox        admin-created test business: complimentary, sandbox environment (also marked in
--                                  test_businesses, which carries the existing sandbox safeguards).
--                   customer       explicit "ordinary customer" (same as no row; kept for an audited reclassification).
--   billing         complimentary | stripe        (the entitlement: complimentary = no checkout, no subscription needed)
--   environment     production | sandbox          (operational environment, separate from billing)
--   provider_spend  allowed | blocked             (paid outside providers for CUSTOMER-FACING use: ads live launch,
--                                                  public receptionist chat/voice; admin Lab sessions are gated by the Lab)
-- Classification changes are written to the permanent audit log (account.classify) with from/to.
CREATE TABLE IF NOT EXISTS business_accounts (
  customer       TEXT PRIMARY KEY REFERENCES customers(id),
  classification TEXT NOT NULL CHECK (classification IN ('internal_live', 'sandbox', 'customer')),
  billing        TEXT NOT NULL CHECK (billing IN ('complimentary', 'stripe')),
  environment    TEXT NOT NULL CHECK (environment IN ('production', 'sandbox')),
  provider_spend TEXT NOT NULL DEFAULT 'allowed' CHECK (provider_spend IN ('allowed', 'blocked')),
  note           TEXT NOT NULL DEFAULT '',
  set_by         TEXT NOT NULL,
  set_at         INTEGER NOT NULL
);
