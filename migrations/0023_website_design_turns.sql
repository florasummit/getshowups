-- The AI website designer conversation (server/ai-designer.js): the owner's messages and the designer's replies, in
-- order. Each designer turn points at the stored generation (website_generations) holding the design it produced and the
-- design before it (for undo). Additive, idempotent.
CREATE TABLE IF NOT EXISTS website_design_turns (
  customer      TEXT NOT NULL REFERENCES customers(id),
  role          TEXT NOT NULL CHECK (role IN ('owner', 'designer')),
  text          TEXT NOT NULL,
  generation_id TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS website_design_turns_customer ON website_design_turns (customer, created_at);
