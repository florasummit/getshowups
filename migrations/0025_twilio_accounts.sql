-- Twilio: one GetShowUps parent account, one Twilio SUBACCOUNT per business (server/followups/twilio.js,
-- server/followups/provisioning.js). Additive and idempotent. Until it is applied no business can text (readiness
-- reports no_account) and every existing flow is unchanged.

-- The business's own Twilio subaccount. Its auth token is needed for Trust Hub / Messaging API calls made inside the
-- subaccount and for webhook signatures; stored only AES-GCM encrypted (HKDF subkey of TOKEN_ENCRYPTION_KEY, bound
-- to business + account SID). Never returned, logged or shown.
CREATE TABLE IF NOT EXISTS sms_accounts (
  customer        TEXT PRIMARY KEY REFERENCES customers(id),
  account_sid     TEXT NOT NULL UNIQUE,            -- AC… (subaccount of TWILIO_ACCOUNT_SID)
  auth_token_enc  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  usage_period    TEXT,                            -- e.g. 2026-11 (provider usage records, read-only sync)
  usage_count     INTEGER,                         -- messages in that period (provider-reported)
  usage_micros    INTEGER,                         -- provider-reported price in micro-dollars
  usage_synced_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Provider objects created for a business's registration, one row per kind (customer_profile, business_info,
-- representative, address, address_document, a2p_bundle, a2p_info, brand, messaging_service, campaign, phone_number).
-- `sid` is Twilio's id; `status` is what Twilio last reported; `detail` an allowlisted code (never free text).
CREATE TABLE IF NOT EXISTS sms_provider_objects (
  customer    TEXT NOT NULL REFERENCES customers(id),
  kind        TEXT NOT NULL,
  sid         TEXT,                                -- NULL while a request's outcome is unknown (never re-sent blindly)
  status      TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (customer, kind)
);

-- Registration facts Twilio needs beyond sms_registrations (owner-entered): structured address, the authorized
-- representative, industry, and the registration path chosen from the business type.
CREATE TABLE IF NOT EXISTS sms_registration_extra (
  customer         TEXT PRIMARY KEY REFERENCES customers(id),
  path             TEXT NOT NULL CHECK (path IN ('low_volume_standard', 'standard', 'sole_proprietor')),
  street           TEXT NOT NULL,
  street2          TEXT,
  city             TEXT NOT NULL,
  region           TEXT NOT NULL,                  -- US state, 2 letters
  postal_code      TEXT NOT NULL,
  rep_first_name   TEXT NOT NULL,
  rep_last_name    TEXT NOT NULL,
  rep_title        TEXT,                           -- standard paths only
  rep_job_position TEXT,
  industry         TEXT NOT NULL,                  -- Twilio vertical / business_industry code
  updated_at       INTEGER NOT NULL
);
