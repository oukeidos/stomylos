-- Public schema 33 -> 34: content-free Genie request history.
CREATE TABLE genie_request_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  parent_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT,
  settings TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', failure TEXT
);
CREATE INDEX genie_requests_session ON genie_request_attempts(session_id,created_at,id);
