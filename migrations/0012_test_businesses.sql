-- Test businesses: marked by a platform admin (audited). A marked business is kept out of platform
-- metrics and can never use live operations (real Google Ads accounts, messages to real recipients,
-- live Stripe), whatever the global release switches say. Rows are never deleted: unmarking sets
-- is_test = 0 and unmarked_at, and anything created before unmarked_at stays sandboxed.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS test_businesses (
  customer    TEXT PRIMARY KEY REFERENCES customers(id),
  is_test     INTEGER NOT NULL CHECK (is_test IN (0, 1)),
  marked_by   TEXT NOT NULL,
  marked_at   INTEGER NOT NULL,
  unmarked_by TEXT,
  unmarked_at INTEGER
);
