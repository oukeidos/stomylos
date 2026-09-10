CREATE TABLE memory_legacy_bridge (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  document TEXT NOT NULL,
  document_hash TEXT NOT NULL
);
CREATE TABLE memory_legacy_seeds (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  document TEXT NOT NULL,
  document_hash TEXT NOT NULL
);
