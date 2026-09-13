CREATE TABLE conversation_openers (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  question TEXT, body TEXT, body_hash TEXT,
  message_id TEXT NOT NULL UNIQUE,
  selected_attempt_id TEXT,
  CHECK((question IS NULL AND body IS NULL AND body_hash IS NULL) OR
        (question IS NOT NULL AND body IS NOT NULL AND body_hash IS NOT NULL))
);
CREATE TABLE opener_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES conversation_openers(session_id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES opener_attempts(id),
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','received','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT,
  response_content TEXT, metadata TEXT NOT NULL DEFAULT '{}', failure TEXT,
  provider_request TEXT
);
CREATE UNIQUE INDEX opener_single_live ON opener_attempts(session_id) WHERE status IN ('queued','dispatched','received');
CREATE UNIQUE INDEX opener_single_success ON opener_attempts(session_id) WHERE status='succeeded';
