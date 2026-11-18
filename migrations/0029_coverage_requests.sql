-- Service-area (coverage) requests: a lead whose ZIP is outside the business's listed ZIPs, or couldn't be verified, is
-- KEPT (leads.status stays 'unqualified' = not bookable yet) and gets one row here for the owner to decide.
--   check:  'outside'  a real ZIP the business doesn't list
--           'unknown'  well-formed but not a known ZIP area (the visitor confirmed it as typed)
--           'invalid'  not a ZIP at all (website forms only: a plain form can't ask again without losing what was typed)
--   status: 'pending' (owner review needed) → 'approved' (lead becomes bookable: leads.status 'new', the visitor gets the
--           same booking link, no starting over) or 'declined' (lead kept, never bookable). The business's service ZIP
--           list is NEVER changed by a decision.
-- decided_by is a reference (never an email). Additive and idempotent.
CREATE TABLE IF NOT EXISTS coverage_requests (
  lead_id     TEXT PRIMARY KEY REFERENCES leads(id),
  customer    TEXT NOT NULL REFERENCES customers(id),
  zip         TEXT NOT NULL DEFAULT '',
  zip_check   TEXT NOT NULL CHECK (zip_check IN ('outside', 'unknown', 'invalid')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT
);
CREATE INDEX IF NOT EXISTS coverage_requests_customer ON coverage_requests (customer, status, created_at);
