-- Public schema 27 -> 28: per-input ADD queue and bounded active memory.
CREATE TABLE memory_add_jobs (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  input_json TEXT NOT NULL, input_hash TEXT NOT NULL, config TEXT NOT NULL, config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','received','failed','interrupted','completed','skipped')),
  failure TEXT, changes TEXT
);
CREATE TABLE memory_add_attempts (
  id TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES memory_add_jobs(ordinal) ON DELETE CASCADE,
  body TEXT NOT NULL, body_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','received','succeeded','failed','interrupted','cancelled')),
  created_at TEXT NOT NULL, response_content TEXT, metadata TEXT NOT NULL DEFAULT '{}',
  failure TEXT, provider_request TEXT
);
CREATE UNIQUE INDEX memory_add_one_active ON memory_add_attempts(job_id) WHERE status IN ('queued','dispatched','received');
CREATE TRIGGER immutable_memory_add_input BEFORE UPDATE OF message_id,session_id,input_json,input_hash,config,config_hash,created_at ON memory_add_jobs
BEGIN SELECT RAISE(ABORT,'immutable memory ADD input'); END;
CREATE TABLE memory_item_metadata (
  id TEXT PRIMARY KEY,
  source_order INTEGER NOT NULL, item_index INTEGER NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  observed_at TEXT, origin TEXT NOT NULL CHECK(origin IN ('legacy','add','manual')),
  UNIQUE(source_order,item_index)
);
CREATE TABLE memory_cutover_archive (
  id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL, document_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0 CHECK(dismissed IN (0,1))
);
CREATE TABLE memory_retired_jobs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL
);
CREATE INDEX memory_add_pending ON memory_add_jobs(ordinal) WHERE state NOT IN ('completed','skipped');
CREATE TRIGGER immutable_memory_cutover BEFORE UPDATE OF document,document_hash,created_at ON memory_cutover_archive
BEGIN SELECT RAISE(ABORT,'immutable memory archive'); END;
CREATE TRIGGER immutable_memory_add_attempt BEFORE UPDATE OF id,job_id,body,body_hash,created_at ON memory_add_attempts
BEGIN SELECT RAISE(ABORT,'immutable memory ADD attempt'); END;
