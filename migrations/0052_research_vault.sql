-- Research Vault (server/research/, docs/RESEARCH_VAULT.md): GetShowUps' own research records. Corporate research only:
-- no customer personal data, no raw conversations; business ids appear only for GetShowUps-owned businesses (internal_live)
-- or as aggregates. Additive and idempotent. Until applied, /api/research/* answers 404 like any unauthorized request.

-- Who may use the vault besides the founder (the founder comes from RESEARCH_FOUNDER_EMAIL). Roles for later:
-- director (read + write + manage researchers), researcher (read + write). A revoked row stays (revoked_at).
CREATE TABLE IF NOT EXISTS research_members (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('director', 'researcher')),
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Every research record is a node of one kind (the knowledge graph without a graph database). body = the kind's
-- validated fields (JSON). The current version lives here; every version, the first included, is in research_versions.
CREATE TABLE IF NOT EXISTS research_nodes (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('program', 'question', 'thesis', 'assumption', 'hypothesis', 'model', 'experiment', 'observation',
                                           'evidence', 'counterexample', 'recommendation', 'outcome', 'note')),
  program    TEXT,                               -- e.g. GS-ECO-001
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '{}',
  confidence REAL,                               -- 0..1, belief in a hypothesis/thesis/model; NULL = not assessed
  version    INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS research_nodes_kind ON research_nodes (kind, updated_at);
CREATE INDEX IF NOT EXISTS research_nodes_program ON research_nodes (program, kind);

-- Immutable history: a change never edits a version, it adds one (with the reason). Nothing is ever deleted.
CREATE TABLE IF NOT EXISTS research_versions (
  node_id    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  body       TEXT NOT NULL,
  confidence REAL,
  reason     TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, version)
);
CREATE TRIGGER IF NOT EXISTS research_versions_no_update BEFORE UPDATE ON research_versions BEGIN SELECT RAISE(ABORT, 'research_versions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS research_versions_no_delete BEFORE DELETE ON research_versions BEGIN SELECT RAISE(ABORT, 'research_versions is append-only'); END;

-- Links between records. Append-only too: a contradiction stays recorded even when a belief changes.
CREATE TABLE IF NOT EXISTS research_edges (
  id         TEXT PRIMARY KEY,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  relation   TEXT NOT NULL CHECK (relation IN ('supports', 'contradicts', 'assumes', 'tests', 'derives', 'informs', 'answers', 'supersedes', 'measures')),
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS research_edges_unique ON research_edges (from_id, to_id, relation);
CREATE INDEX IF NOT EXISTS research_edges_to ON research_edges (to_id);
CREATE TRIGGER IF NOT EXISTS research_edges_no_update BEFORE UPDATE ON research_edges BEGIN SELECT RAISE(ABORT, 'research_edges is append-only'); END;
CREATE TRIGGER IF NOT EXISTS research_edges_no_delete BEFORE DELETE ON research_edges BEGIN SELECT RAISE(ABORT, 'research_edges is append-only'); END;
