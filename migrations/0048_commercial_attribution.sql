-- Commercial attribution, referral partners and the commission ledger (server/commercial-attribution.js,
-- server/partners.js, server/commissions.js). The referral program is INACTIVE unless REFERRALS_ENABLED is exactly
-- 'true'; nothing here pays anyone (no payout code exists). Additive and idempotent.

-- Referral partners: GetShowUps' own records. Partners have no login and no access to anything.
-- Lifecycle: invited → onboarding → active ⇄ paused → ended (ended is final). Only an ACTIVE partner gains referrals or
-- earns, and activation needs terms + acceptance of the current agreement (server/partners.js).
-- payout_reference: free text only ("PayPal, partner's business account"); bank and card numbers are refused before storage.
CREATE TABLE IF NOT EXISTS referral_partners (
  id               TEXT PRIMARY KEY,              -- prt_<random>
  name             TEXT NOT NULL,
  contact_email    TEXT,                          -- our records + the self-referral check only; never shown outside the partner admin
  code             TEXT NOT NULL,                 -- lower case, random (case-insensitive match)
  status           TEXT NOT NULL CHECK (status IN ('invited', 'onboarding', 'active', 'paused', 'ended')),
  payout_reference TEXT,
  created_by       TEXT NOT NULL,                 -- platform admin email
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_partners_code ON referral_partners (code);

-- Commission terms, versioned and append-only. terms: JSON { type: 'percent'|'fixed', value, currency? (fixed),
-- recurring: 'once'|'months:N'|'lifetime', windowDays } typed by a platform admin; no default terms exist anywhere.
-- A referred business earns under the version in effect when it was attributed (server/partner-terms.js).
CREATE TABLE IF NOT EXISTS partner_terms (
  id             INTEGER PRIMARY KEY,
  partner_id     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  terms          TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (partner_id, version)
);
CREATE TRIGGER IF NOT EXISTS partner_terms_append_only_u BEFORE UPDATE ON partner_terms BEGIN SELECT RAISE(ABORT, 'partner_terms is append-only'); END;
CREATE TRIGGER IF NOT EXISTS partner_terms_append_only_d BEFORE DELETE ON partner_terms BEGIN SELECT RAISE(ABORT, 'partner_terms is append-only'); END;

-- Partner agreement documents, as versions (the newest is the current one). Text and/or an https reference.
CREATE TABLE IF NOT EXISTS partner_agreements (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  version_label TEXT NOT NULL UNIQUE,
  body          TEXT,
  url           TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS partner_agreements_append_only_u BEFORE UPDATE ON partner_agreements BEGIN SELECT RAISE(ABORT, 'partner_agreements is append-only'); END;
CREATE TRIGGER IF NOT EXISTS partner_agreements_append_only_d BEFORE DELETE ON partner_agreements BEGIN SELECT RAISE(ABORT, 'partner_agreements is append-only'); END;

-- A partner's acceptance of one agreement version, recorded by a platform admin (partners have no login).
CREATE TABLE IF NOT EXISTS partner_acceptances (
  id           INTEGER PRIMARY KEY,
  partner_id   TEXT NOT NULL,
  agreement_id INTEGER NOT NULL,
  accepted_at  INTEGER NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('recorded_by_admin')),
  evidence     TEXT,                            -- optional note ("signed PDF in shared drive, 2027-01-04")
  recorded_by  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (partner_id, agreement_id)
);
CREATE TRIGGER IF NOT EXISTS partner_acceptances_append_only_u BEFORE UPDATE ON partner_acceptances BEGIN SELECT RAISE(ABORT, 'partner_acceptances is append-only'); END;
CREATE TRIGGER IF NOT EXISTS partner_acceptances_append_only_d BEFORE DELETE ON partner_acceptances BEGIN SELECT RAISE(ABORT, 'partner_acceptances is append-only'); END;

-- Payouts made OUTSIDE GetShowUps, recorded by a platform admin (GetShowUps never initiates a payment). Append-only:
-- a mistaken payout gets a 'reversal' row (reverses = its id, at most one), never an edit.
CREATE TABLE IF NOT EXISTS partner_payouts (
  id                 TEXT PRIMARY KEY,           -- pay_<random>
  partner_id         TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('payout', 'reversal')),
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),
  currency           TEXT NOT NULL,
  paid_on            INTEGER,                    -- payout: the day it was paid outside GetShowUps
  method_label       TEXT,
  external_reference TEXT,
  period_from        INTEGER,
  period_to          INTEGER,
  note               TEXT,
  reverses           TEXT UNIQUE,                -- reversal: the payout it cancels (one reversal per payout)
  recorded_by        TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS partner_payouts_partner ON partner_payouts (partner_id, created_at);
CREATE TRIGGER IF NOT EXISTS partner_payouts_append_only_u BEFORE UPDATE ON partner_payouts BEGIN SELECT RAISE(ABORT, 'partner_payouts is append-only'); END;
CREATE TRIGGER IF NOT EXISTS partner_payouts_append_only_d BEFORE DELETE ON partner_payouts BEGIN SELECT RAISE(ABORT, 'partner_payouts is append-only'); END;

-- Which ledger accruals a payout settled. An accrual is settled at most once per cycle; cycle = how many earlier
-- settlements of it were cancelled by a payout reversal, so a settled accrual can never be settled again unless its
-- payout was reversed.
CREATE TABLE IF NOT EXISTS payout_settlements (
  id           INTEGER PRIMARY KEY,
  payout_id    TEXT NOT NULL,
  ledger_id    INTEGER NOT NULL,
  cycle        INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (ledger_id, cycle)
);
CREATE INDEX IF NOT EXISTS payout_settlements_payout ON payout_settlements (payout_id);
CREATE TRIGGER IF NOT EXISTS payout_settlements_append_only_u BEFORE UPDATE ON payout_settlements BEGIN SELECT RAISE(ABORT, 'payout_settlements is append-only'); END;
CREATE TRIGGER IF NOT EXISTS payout_settlements_append_only_d BEFORE DELETE ON payout_settlements BEGIN SELECT RAISE(ABORT, 'payout_settlements is append-only'); END;

-- One row per business, first touch: written once when the business is created; changed only by an audited admin
-- correction (corrected_at / corrected_by).
CREATE TABLE IF NOT EXISTS commercial_attribution (
  customer           TEXT PRIMARY KEY,
  channel            TEXT NOT NULL CHECK (channel IN ('self_serve', 'founder', 'sales_rep', 'partner')),
  marketing_source   TEXT,                        -- utm_source / ref label, as customers.source
  partner_id         TEXT,                        -- referring partner (NULL: none, or refused: see partner_refusal)
  closing_rep_email  TEXT,                        -- staff address of the closing representative
  partner_touched_at INTEGER,                     -- when the referral link was first opened (clamped to created_at)
  partner_refusal    TEXT,                        -- code: unknown_code | not_active | self_referral | outside_window | no_terms
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
  terms_version_id      INTEGER,                   -- partner_terms.id applied (accruals and their reversals)
  reverses              INTEGER,                   -- accrual id a reversal reduces
  created_at            INTEGER NOT NULL,
  UNIQUE (kind, stripe_object_id)
);
CREATE INDEX IF NOT EXISTS commission_ledger_partner ON commission_ledger (partner_id, created_at);
CREATE INDEX IF NOT EXISTS commission_ledger_customer ON commission_ledger (customer, kind);
CREATE TRIGGER IF NOT EXISTS commission_ledger_append_only_u BEFORE UPDATE ON commission_ledger BEGIN SELECT RAISE(ABORT, 'commission_ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS commission_ledger_append_only_d BEFORE DELETE ON commission_ledger BEGIN SELECT RAISE(ABORT, 'commission_ledger is append-only'); END;
