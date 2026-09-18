-- Public schema 44 -> 45: versioned associative Jev attempts; old snapshots remain immutable.
CREATE TABLE associative_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed','interrupted')),
  deadline REAL NOT NULL,
  snapshot TEXT NOT NULL,
  provider_request TEXT,
  scores TEXT,
  selection TEXT,
  metadata TEXT,
  failure TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX associative_attempt_session ON associative_attempts(session_id);
