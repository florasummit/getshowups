-- Assisted enrollment (docs/ASSISTED_ENROLLMENT.md): commercial staff roles and founder/rep-assisted sign-ups.
-- Additive. Until applied: nobody but PLATFORM_ADMIN_EMAILS has staff access (server/roles.js), the Enrollments screen
-- says it isn't available yet, and every existing flow behaves exactly as before.
--
-- commercial_roles: who may sell (sales_rep) or configure pending workspaces (onboarding). Granted and revoked only by a
-- platform admin (audited). Rows are never deleted: a revocation sets revoked_at and takes effect on the next request.
-- At most one ACTIVE grant per email + role.
CREATE TABLE IF NOT EXISTS commercial_roles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sales_rep', 'onboarding')),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_by TEXT,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS commercial_roles_active ON commercial_roles (email, role) WHERE revoked_at IS NULL;

-- assisted_enrollments: one prospect handled by GetShowUps staff on a call. customer is NULL until "Create workspace"
-- (then the business created through the ordinary createCustomer path, with a self_signups row so it stays unpaid:
-- not hosted, not bookable, no paid tools, no provider spend until Stripe's verified subscription event).
-- stage: prospect | payment_sent | paid | configuring | ready | invited | claimed | abandoned. 'paid' is only ever
-- written by the verified Stripe webhook path (or derived from the subscription the webhook stored), never by staff.
-- notes are free text for the call; anything that looks like a card number is refused before it is stored.
-- terms_*: what the owner accepted when claiming (version + time). assignment_closed_at: staff access ended (claim).
CREATE TABLE IF NOT EXISTS assisted_enrollments (
  id                   TEXT PRIMARY KEY,
  customer             TEXT UNIQUE,
  business_name        TEXT NOT NULL,
  owner_name           TEXT NOT NULL DEFAULT '',
  owner_email          TEXT NOT NULL,
  phone                TEXT NOT NULL DEFAULT '',
  timezone             TEXT NOT NULL DEFAULT 'America/New_York',
  notes                TEXT NOT NULL DEFAULT '',
  plan_id              TEXT,
  assigned_rep_email   TEXT,
  stage                TEXT NOT NULL DEFAULT 'prospect',
  created_by           TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  workspace_at         INTEGER,
  payment_sent_at      INTEGER,
  payment_sends        INTEGER NOT NULL DEFAULT 0,
  paid_at              INTEGER,
  config_started_at    INTEGER,
  invite_id            TEXT,
  invited_at           INTEGER,
  claimed_at           INTEGER,
  claimed_by           TEXT,
  terms_version        TEXT,
  terms_accepted_at    INTEGER,
  abandoned_at         INTEGER,
  assignment_closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS assisted_enrollments_rep ON assisted_enrollments (assigned_rep_email, updated_at);
CREATE INDEX IF NOT EXISTS assisted_enrollments_invite ON assisted_enrollments (invite_id);
