-- Hidden website photos (Website Studio, 2026-11-19): a photo the owner removed from their photo list while a saved
-- version, an AI-designer undo or a draft checkpoint still shows it. The bytes stay in website_assets (a restore must
-- still show the photo); hidden photos are left out of the photo list and every picker. "Show" deletes the row.
-- Rows hold ids and a time only (no personal data); erased with the account (server/deletion.js ERASED_TABLES).
-- Additive and idempotent. Until it is applied, hiding answers not_available and nothing else changes.
CREATE TABLE IF NOT EXISTS website_asset_hidden (
  asset      TEXT PRIMARY KEY,
  customer   TEXT NOT NULL REFERENCES customers(id),
  hidden_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS website_asset_hidden_customer ON website_asset_hidden (customer);
