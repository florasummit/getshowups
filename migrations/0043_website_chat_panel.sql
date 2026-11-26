-- Website chat panel: the owner's choice to open the chat inside a panel on their website instead of the plain link to
-- the chat page. No row = off (the link, exactly as before). Additive. Until applied: the link, and the setting is hidden.
CREATE TABLE IF NOT EXISTS website_chat_settings (
  customer   TEXT PRIMARY KEY REFERENCES customers(id),
  panel      INTEGER NOT NULL DEFAULT 0 CHECK (panel IN (0, 1)),
  updated_at INTEGER NOT NULL
);
