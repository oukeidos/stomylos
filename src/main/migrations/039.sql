-- Public schema 38 -> 39: content-free Dadouchos request history.
CREATE TABLE dadouchos_request_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT,
  settings TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', failure TEXT
);
CREATE INDEX dadouchos_requests_session ON dadouchos_request_attempts(session_id,created_at,id);
