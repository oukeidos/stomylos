-- Public schema 13 -> 14. Frozen migration; subsequent corrections need a new step.
CREATE TABLE end_processing (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  cancelled_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE end_stage_state (
  session_id TEXT NOT NULL REFERENCES end_processing(session_id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('grammar','starter','update','cleanup')),
  automatic_retry_used INTEGER NOT NULL DEFAULT 0 CHECK(automatic_retry_used IN (0,1)),
  response_id TEXT,
  response_content TEXT,
  response_metadata TEXT,
  PRIMARY KEY(session_id,stage)
);
CREATE TABLE memory_candidates (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  update_attempt_id TEXT NOT NULL REFERENCES memory_attempts(id),
  document TEXT NOT NULL,
  document_hash TEXT NOT NULL,
  config TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','received','failed','interrupted','completed','cancelled')),
  selected_attempt_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE memory_cleanup_attempts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES memory_candidates(session_id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES memory_cleanup_attempts(id),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','received','succeeded','failed','interrupted','cancelled')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  finished_at TEXT,
  response_content TEXT,
  result TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  failure TEXT
);
