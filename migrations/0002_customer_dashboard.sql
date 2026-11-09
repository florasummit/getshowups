-- Customer accounts, sign-in sessions, leads, and appointments.
-- Apply once to the D1 database bound as ONBOARDING_DB (production requires approval):
--   npx wrangler d1 execute getshowups-onboarding --remote --file=migrations/0002_customer_dashboard.sql

-- One row per business. id doubles as the public booking slug (/book/<id>) and the KV key google:<id>.
CREATE TABLE IF NOT EXISTS customers (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  timezone           TEXT NOT NULL,                     -- IANA zone
  service_zips       TEXT NOT NULL DEFAULT '',          -- comma list; empty = serve everywhere
  slot_minutes       INTEGER NOT NULL DEFAULT 60,
  day_start          TEXT NOT NULL DEFAULT '09:00',     -- HH:MM local
  day_end            TEXT NOT NULL DEFAULT '17:00',
  workdays           TEXT NOT NULL DEFAULT '1,2,3,4,5', -- 0 = Sunday … 6 = Saturday
  hours_confirmed_at INTEGER,                           -- set when the owner saves booking hours
  source             TEXT NOT NULL DEFAULT 'direct',    -- acquisition source (utm_source/ref, 'invite', 'assisted')
  created_via        TEXT NOT NULL DEFAULT 'self_serve' CHECK (created_via IN ('self_serve', 'admin_invite', 'admin_link')),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- People who may sign in to a business. One email belongs to one business.
CREATE TABLE IF NOT EXISTS customer_users (
  email      TEXT PRIMARY KEY,                          -- lowercase, Google-verified
  customer   TEXT NOT NULL REFERENCES customers(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS customer_users_customer ON customer_users (customer);

-- Sign-in sessions. Only SHA-256 of the token is stored. Business membership is resolved on
-- every request from customer_users, so a new account and revocation take effect immediately.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);

-- Leads captured on a business's booking page.
CREATE TABLE IF NOT EXISTS leads (
  id         TEXT PRIMARY KEY,
  customer   TEXT NOT NULL REFERENCES customers(id),
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT NOT NULL,
  need       TEXT NOT NULL,
  zip        TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('new', 'unqualified', 'booked')),
  token_hash TEXT NOT NULL,                             -- lets only the submitting browser book for this lead
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_customer ON leads (customer, created_at);

-- Appointments. The partial unique index makes double-booking a slot impossible.
CREATE TABLE IF NOT EXISTS appointments (
  id              TEXT PRIMARY KEY,
  customer        TEXT NOT NULL REFERENCES customers(id),
  lead_id         TEXT NOT NULL REFERENCES leads(id),
  start_at        INTEGER NOT NULL,                     -- epoch ms
  end_at          INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'booked', 'showed', 'no_show', 'cancelled')),
  google_event_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_one_per_slot ON appointments (customer, start_at) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS appointments_customer ON appointments (customer, start_at);

-- Fixed-window rate limits for public and sign-in endpoints. key = "<rule>:<sha256(ip or customer)>".
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  win        INTEGER NOT NULL,                        -- window number (now / window length)
  count      INTEGER NOT NULL,
  expires_at INTEGER NOT NULL                         -- epoch ms; rows past this are purged
);
