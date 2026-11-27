-- Passwordless email sign-in (server/email-auth.js): one row per sign-in request. Additive. Until applied, email sign-in
-- answers 503 not_available and the sign-in screens offer Google only (exactly as before); sessions are unchanged.
--
-- A request carries a single-use LINK and a 6-digit CODE, both bound to this row, both dead after first use, expiry
-- (15 minutes) or 5 wrong codes. Nothing here can be turned back into a secret or an address:
--   email_hash   SHA-256 of the lower-cased address (the address itself is never stored here)
--   link_hash    SHA-256 of the 256-bit link token
--   code_hash    HMAC-SHA-256 of the code under a key derived from TOKEN_ENCRYPTION_KEY (a 6-digit code's plain hash
--                could be reversed by trying all million values)
--   browser_hash SHA-256 of a random value kept in an HttpOnly cookie of the browser that asked: the LINK works only in
--                that browser; the CODE works in any browser (it is typed by the person who read the email)
-- Not business data (no customer column): rows are removed a day after they expire (server/sessions-purge.js).
CREATE TABLE IF NOT EXISTS email_login_tokens (
  id           TEXT PRIMARY KEY,
  email_hash   TEXT NOT NULL,
  link_hash    TEXT NOT NULL UNIQUE,
  code_hash    TEXT NOT NULL,
  browser_hash TEXT NOT NULL,
  next         TEXT NOT NULL DEFAULT '/dashboard',
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);
CREATE INDEX IF NOT EXISTS email_login_tokens_email ON email_login_tokens (email_hash, expires_at);
CREATE INDEX IF NOT EXISTS email_login_tokens_expiry ON email_login_tokens (expires_at);
