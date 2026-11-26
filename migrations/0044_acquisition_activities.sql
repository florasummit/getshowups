-- GetShowUps' own customer acquisition (Admin → Growth → Activities): one row per tracking code (the utm_campaign of a
-- prepared activity's link, e.g. out-01), holding what only the founder knows: whether it was approved, sent, followed
-- up, answered or declined, and what it cost. Results (prospects, demos, businesses, paying) are never stored here: they
-- are read from the sales business's leads by the same code (server/sales-attribution.js). Platform-level, no customer
-- column, no contact details. Additive. Until applied: the catalog and results still show; statuses can't be saved.
CREATE TABLE IF NOT EXISTS acquisition_codes (
  code           TEXT PRIMARY KEY,
  activity       TEXT NOT NULL,
  label          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared', 'approved', 'sent', 'followed_up', 'replied', 'declined')),
  cost_cents     INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  approved_at    INTEGER,
  sent_at        INTEGER,
  followed_up_at INTEGER,
  replied_at     INTEGER,
  updated_at     INTEGER NOT NULL
);
