-- Calls Google reports for a business's connected Google Ads account (call_view; docs/GOOGLE_ACQUISITION.md "Calls").
-- Additive and idempotent. Google gives time, length, answered or missed, and the campaign; never the caller's number, and we
-- do not store the area code it offers. handled_at = the owner says they called back; lead_id = the customer the owner linked.
-- Until it is applied, call reporting stays hidden.
CREATE TABLE IF NOT EXISTS google_calls (
  id                   TEXT NOT NULL,
  customer             TEXT NOT NULL REFERENCES customers(id),
  campaign_external_id TEXT,
  local_time           TEXT NOT NULL,
  started_at           INTEGER NOT NULL,
  duration_seconds     INTEGER,
  status               TEXT NOT NULL DEFAULT 'UNKNOWN',
  shown_on             TEXT,
  synced_at            INTEGER NOT NULL,
  handled_at           INTEGER,
  lead_id              TEXT REFERENCES leads(id),
  PRIMARY KEY (customer, id)
);
CREATE INDEX IF NOT EXISTS google_calls_customer ON google_calls (customer, started_at);
CREATE TABLE IF NOT EXISTS google_call_setup (
  customer        TEXT PRIMARY KEY REFERENCES customers(id),
  reporting       INTEGER,
  numbers_on_ads  INTEGER,
  time_zone       TEXT,
  checked_at      INTEGER NOT NULL
);
