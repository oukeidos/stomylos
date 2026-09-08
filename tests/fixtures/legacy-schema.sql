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
