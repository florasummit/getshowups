-- Commercial attribution, referral partners and the commission ledger (server/commercial-attribution.js,
-- server/partners.js, server/commissions.js). The referral program is INACTIVE unless REFERRALS_ENABLED is exactly
-- 'true'; nothing here pays anyone (no payout code exists). Additive and idempotent.

-- Referral partners: GetShowUps' own records. Partners have no login and no access to anything.
-- terms: JSON { type: 'percent'|'fixed', value, currency? (fixed), recurring: 'once'|'months:N'|'lifetime', windowDays }
-- set by a platform admin, or NULL (no terms yet: nothing accrues). No default terms exist anywhere.
CREATE TABLE IF NOT EXISTS referral_partners (
  id            TEXT PRIMARY KEY,                 -- prt_<random>
  name          TEXT NOT NULL,
  contact_email TEXT,                             -- our records + the self-referral check only; never shown outside the partner admin
  code          TEXT NOT NULL,                    -- lower case, random (case-insensitive match)
  status        TEXT NOT NULL CHECK (status IN ('active', 'paused')),
  terms         TEXT,
  created_by    TEXT NOT NULL,                    -- platform admin email
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_partners_code ON referral_partners (code);

-- One row per business, first touch: written once when the business is created; changed only by an audited admin
-- correction (corrected_at / corrected_by).
CREATE TABLE IF NOT EXISTS commercial_attribution (
  customer           TEXT PRIMARY KEY,
  channel            TEXT NOT NULL CHECK (channel IN ('self_serve', 'founder', 'sales_rep', 'partner')),
  marketing_source   TEXT,                        -- utm_source / ref label, as customers.source
  partner_id         TEXT,                        -- referring partner (NULL: none, or refused: see partner_refusal)
  closing_rep_email  TEXT,                        -- staff address of the closing representative
  partner_touched_at INTEGER,                     -- when the referral link was first opened (clamped to created_at)
  partner_refusal    TEXT,                        -- code: unknown_code | paused | program_off | self_referral | outside_window
  commission_ended_at INTEGER,                    -- the subscription ended: no accrual for payments after this time
  corrected_at       INTEGER,
  corrected_by       TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS commercial_attribution_partner ON commercial_attribution (partner_id);

-- Commission ledger: append-only like audit_log. amount_cents is signed: accruals positive, reversals negative.
-- (kind, stripe_object_id) is unique, so a replayed webhook can never add a second commission or reversal.
CREATE TABLE IF NOT EXISTS commission_ledger (
  id                    INTEGER PRIMARY KEY,
  partner_id            TEXT NOT NULL,
  customer              TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('accrual', 'reversal')),
  stripe_object_id      TEXT NOT NULL,             -- accrual: invoice id · reversal: refund:<charge>:<cumulative> | dispute:<id>
  stripe_invoice_id     TEXT,
  stripe_charge_id      TEXT,
  stripe_payment_intent TEXT,
  amount_cents          INTEGER NOT NULL,
  currency              TEXT NOT NULL,
  basis_cents           INTEGER NOT NULL,          -- collected amount the commission is computed from (tax excluded)
  paid_cents            INTEGER NOT NULL,          -- amount Stripe reports paid (accrual) or refunded/disputed (reversal)
  livemode              INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  rule                  TEXT NOT NULL,             -- JSON snapshot of the terms applied
  reverses              INTEGER,                   -- accrual id a reversal reduces
  created_at            INTEGER NOT NULL,
  UNIQUE (kind, stripe_object_id)
);
CREATE INDEX IF NOT EXISTS commission_ledger_partner ON commission_ledger (partner_id, created_at);
CREATE INDEX IF NOT EXISTS commission_ledger_customer ON commission_ledger (customer, kind);
CREATE TRIGGER IF NOT EXISTS commission_ledger_append_only_u BEFORE UPDATE ON commission_ledger BEGIN SELECT RAISE(ABORT, 'commission_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS commission_ledger_append_only_d BEFORE DELETE ON commission_ledger BEGIN SELECT RAISE(ABORT, 'commission_ledger is append-only'); END;
