-- Website import (server/site-import.js): what was read from a business's existing public website, kept as data
-- the owner reviews before anything is applied to the private draft. Untrusted text, never instructions.
-- Additive, idempotent.
CREATE TABLE IF NOT EXISTS website_imports (
  id          TEXT PRIMARY KEY,
  customer    TEXT NOT NULL REFERENCES customers(id),
  source_url  TEXT NOT NULL,
  platform    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('done', 'failed')),
  error       TEXT,
  result      TEXT,               -- JSON: pages (url, path, title, headings, text, images, prices), skipped, flags
  created_at  INTEGER NOT NULL,
  applied_at  INTEGER
);
CREATE INDEX IF NOT EXISTS website_imports_customer ON website_imports (customer, created_at);
