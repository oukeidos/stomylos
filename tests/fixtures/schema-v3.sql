CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('draft','active','ended')),
  starter_id TEXT NOT NULL,
  starter_version TEXT NOT NULL,
  starter_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  draft TEXT NOT NULL DEFAULT '',
  manual_character TEXT,
  character TEXT,
  model TEXT,
  chat_config TEXT NOT NULL,
  grammar_config TEXT,
  source_hash TEXT,
  analysis_state TEXT NOT NULL DEFAULT 'none'
    CHECK(analysis_state IN ('none','pending','running','completed','failed','skipped')),
  selected_analysis_id TEXT,
  FOREIGN KEY(selected_analysis_id, id) REFERENCES model_requests(id, session_id)
);
-- next
CREATE UNIQUE INDEX one_unfinished_session ON sessions((1)) WHERE state != 'ended';
-- next
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  sequence INTEGER NOT NULL CHECK(sequence >= 0),
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('learner','starter','model')),
  delivery TEXT NOT NULL CHECK(delivery IN ('complete','streaming','interrupted')),
  request_id TEXT REFERENCES model_requests(id),
  UNIQUE(session_id, sequence),
  UNIQUE(id, session_id),
  CHECK((role='user' AND origin='learner' AND delivery='complete') OR
        (role='assistant' AND origin IN ('starter','model')))
);
-- next
CREATE TABLE starter_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL CHECK(kind IN ('presented','replaced','answered')),
  question_id TEXT NOT NULL,
  version TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- next
CREATE TABLE model_requests (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('router','chat','grammar')),
  parent_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  finished_at TEXT,
  source_sequence INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  config TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  response_content TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  UNIQUE(id, session_id),
  FOREIGN KEY(parent_id, session_id) REFERENCES model_requests(id, session_id)
);
-- next
CREATE UNIQUE INDEX one_pending_request ON model_requests(session_id, role)
  WHERE status IN ('queued','dispatched');
-- next
CREATE TABLE route_decisions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  request_id TEXT,
  contract_version TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  scores TEXT,
  eligible TEXT NOT NULL,
  character TEXT NOT NULL,
  model TEXT NOT NULL,
  reason TEXT NOT NULL,
  fallback_reason TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id, session_id) REFERENCES model_requests(id, session_id)
);
-- next
CREATE TABLE grammar_units (
  analysis_attempt_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  explanation TEXT NOT NULL,
  changed INTEGER NOT NULL CHECK(changed IN (0,1)),
  warnings TEXT NOT NULL,
  evidence_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(evidence_status='unreviewed'),
  PRIMARY KEY(analysis_attempt_id, source_message_id),
  UNIQUE(analysis_attempt_id, ordinal),
  FOREIGN KEY(analysis_attempt_id, session_id) REFERENCES model_requests(id, session_id),
  FOREIGN KEY(source_message_id, session_id) REFERENCES messages(id, session_id),
  CHECK(changed=(text != corrected_text))
);
-- next
CREATE TRIGGER immutable_final_message BEFORE UPDATE ON messages
WHEN OLD.delivery='complete' AND NOT
  (OLD.origin='starter' AND (SELECT state FROM sessions WHERE id=OLD.session_id)='draft')
BEGIN SELECT RAISE(ABORT, 'Final messages are immutable'); END;
-- next
CREATE TRIGGER frozen_message_update BEFORE UPDATE ON messages
WHEN (SELECT state FROM sessions WHERE id=OLD.session_id)='ended'
BEGIN SELECT RAISE(ABORT, 'Ended transcripts are immutable'); END;
-- next
CREATE TRIGGER frozen_message_insert BEFORE INSERT ON messages
WHEN (SELECT state FROM sessions WHERE id=NEW.session_id)='ended'
BEGIN SELECT RAISE(ABORT, 'Ended transcripts are immutable'); END;
-- next
CREATE TRIGGER protect_message_delete BEFORE DELETE ON messages
WHEN OLD.delivery='complete' OR
  (SELECT state FROM sessions WHERE id=OLD.session_id)='ended'
BEGIN SELECT RAISE(ABORT, 'Final messages are immutable'); END;
-- next
CREATE TRIGGER immutable_request_source BEFORE UPDATE OF
  session_id, role, parent_id, source_sequence, source_hash, config, config_hash ON model_requests
BEGIN SELECT RAISE(ABORT, 'Request sources and settings are immutable'); END;
-- next
CREATE TRIGGER grammar_source_guard BEFORE INSERT ON grammar_units
WHEN NOT EXISTS (SELECT 1 FROM messages m JOIN model_requests r ON r.id=NEW.analysis_attempt_id
  JOIN sessions s ON s.id=NEW.session_id
  WHERE m.id=NEW.source_message_id AND m.session_id=NEW.session_id AND
  r.session_id=NEW.session_id AND r.role='grammar' AND r.status='dispatched' AND
  s.state='ended' AND r.source_hash=s.source_hash AND
  m.role='user' AND m.origin='learner' AND m.content=NEW.text)
BEGIN SELECT RAISE(ABORT, 'Invalid grammar source linkage'); END;

-- Starter renewal schema v2. Original v1 definitions above are preserved.
CREATE TABLE starter_renewal_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  source_sequence INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  source_messages TEXT NOT NULL,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  config TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','interrupted')),
  selected_attempt_id TEXT,
  FOREIGN KEY(selected_attempt_id,id) REFERENCES starter_renewal_attempts(id,job_id)
);
CREATE TABLE starter_renewal_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES starter_renewal_jobs(id),
  parent_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  finished_at TEXT,
  response_content TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK(accepted_count BETWEEN 0 AND 2),
  UNIQUE(id,job_id),
  FOREIGN KEY(parent_id,job_id) REFERENCES starter_renewal_attempts(id,job_id)
);
CREATE UNIQUE INDEX one_pending_starter_attempt ON starter_renewal_attempts(job_id)
  WHERE status IN ('queued','dispatched');
CREATE TABLE starter_questions (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('seed','generated')),
  attempt_id TEXT REFERENCES starter_renewal_attempts(id),
  ordinal INTEGER CHECK(ordinal IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('active','available','retired','expired','evicted','duplicate')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  disposition_at TEXT,
  UNIQUE(attempt_id,ordinal),
  CHECK((origin='seed' AND attempt_id IS NULL AND ordinal IS NULL AND expires_at IS NULL) OR
        (origin='generated' AND attempt_id IS NOT NULL AND ordinal IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX starter_queue_order ON starter_questions(state,created_at,attempt_id,ordinal);
CREATE INDEX starter_question_key ON starter_questions(normalized_text);
CREATE TABLE starter_slots (
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 20),
  question_id TEXT NOT NULL UNIQUE REFERENCES starter_questions(id),
  initialized_at TEXT NOT NULL,
  pending_since TEXT,
  pending_reason TEXT CHECK(pending_reason IN ('answered','skipped')),
  CHECK((pending_since IS NULL)=(pending_reason IS NULL))
);
CREATE TABLE starter_skips (
  operation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  outgoing_id TEXT NOT NULL,
  outgoing_version TEXT NOT NULL,
  outgoing_text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  incoming_id TEXT NOT NULL REFERENCES starter_questions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX starter_skip_window ON starter_skips(session_id,created_at);
CREATE TABLE starter_event_details (
  event_id TEXT PRIMARY KEY REFERENCES starter_events(id),
  slot INTEGER REFERENCES starter_slots(slot),
  replacement_created INTEGER NOT NULL CHECK(replacement_created IN (0,1)),
  fallback INTEGER NOT NULL CHECK(fallback IN (0,1)),
  repeat_relaxed INTEGER NOT NULL CHECK(repeat_relaxed IN (0,1))
);
CREATE TRIGGER immutable_starter_question BEFORE UPDATE OF
  id,version,text,normalized_text,origin,attempt_id,ordinal,created_at,expires_at ON starter_questions
BEGIN SELECT RAISE(ABORT, 'Starter question sources are immutable'); END;
CREATE TRIGGER immutable_starter_slot_origin BEFORE UPDATE OF slot,initialized_at ON starter_slots
BEGIN SELECT RAISE(ABORT, 'Starter slot origins are immutable'); END;
CREATE TRIGGER preserve_starter_slots BEFORE DELETE ON starter_slots
BEGIN SELECT RAISE(ABORT, 'Starter slots cannot be removed'); END;
CREATE TRIGGER immutable_starter_job BEFORE UPDATE OF
  id,session_id,created_at,source_sequence,source_hash,source_messages,input_json,input_hash,config,config_hash,model ON starter_renewal_jobs
BEGIN SELECT RAISE(ABORT, 'Starter job sources and settings are immutable'); END;
CREATE TRIGGER immutable_starter_attempt BEFORE UPDATE OF id,job_id,parent_id,created_at ON starter_renewal_attempts
BEGIN SELECT RAISE(ABORT, 'Starter attempt identity is immutable'); END;

-- Character memory schema v3. All v2 definitions above are preserved.
CREATE TABLE character_memories (
  character_id TEXT PRIMARY KEY,
  document TEXT NOT NULL,
  document_hash TEXT NOT NULL
);
CREATE TABLE session_memories (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  character_id TEXT NOT NULL,
  document TEXT NOT NULL,
  document_hash TEXT NOT NULL
);
CREATE TABLE memory_jobs (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
  character_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  config TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','interrupted','skipped')),
  selected_attempt_id TEXT REFERENCES memory_attempts(id)
);
CREATE TABLE memory_attempts (
  id TEXT PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES memory_jobs(ordinal),
  parent_id TEXT,
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed','interrupted')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  finished_at TEXT,
  response_content TEXT,
  result TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  UNIQUE(id,job_id),
  FOREIGN KEY(parent_id,job_id) REFERENCES memory_attempts(id,job_id)
);
CREATE UNIQUE INDEX one_pending_memory_attempt ON memory_attempts(job_id) WHERE status IN ('queued','dispatched');
CREATE INDEX memory_character_order ON memory_jobs(character_id,ordinal);
CREATE TRIGGER immutable_session_memory BEFORE UPDATE ON session_memories
BEGIN SELECT RAISE(ABORT, 'Session memory is immutable'); END;
CREATE TRIGGER immutable_memory_source BEFORE UPDATE OF ordinal,session_id,character_id,source,source_hash,config,config_hash,created_at ON memory_jobs
BEGIN SELECT RAISE(ABORT, 'Memory job sources are immutable'); END;
CREATE TRIGGER immutable_memory_input BEFORE UPDATE OF id,job_id,parent_id,input_json,input_hash,created_at ON memory_attempts
BEGIN SELECT RAISE(ABORT, 'Memory request inputs are immutable'); END;
