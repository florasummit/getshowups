-- Who controls an active conversation (server/conversations/control.js): exactly one controller per conversation at
-- a time — a person ('human') or one automation provider ('provider:<id>', e.g. provider:claude, provider:ghl). A
-- provider holds a lease; a human takeover always wins and holds until released. No message content is stored here.
-- Additive and idempotent.
CREATE TABLE IF NOT EXISTS conversation_control (
  customer        TEXT NOT NULL REFERENCES customers(id),
  conversation_id TEXT NOT NULL,              -- our id for the thread (e.g. the lead id)
  controller      TEXT NOT NULL,              -- 'human' | 'provider:<id>'
  since           INTEGER NOT NULL,
  lease_until     INTEGER,                    -- providers only; NULL for a human (held until released)
  version         INTEGER NOT NULL DEFAULT 1, -- bumps on every change (optimistic concurrency)
  PRIMARY KEY (customer, conversation_id)
);
