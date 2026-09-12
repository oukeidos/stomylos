CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('draft','active','ended')),
  starter_id TEXT,
  starter_version TEXT,
  starter_text TEXT,
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
  opening_kind TEXT NOT NULL DEFAULT 'starter' CHECK(opening_kind IN ('starter','user')),
  opening_revision INTEGER NOT NULL DEFAULT 0 CHECK(opening_revision >= 0),
  parked_starter TEXT,
  last_opening_operation TEXT,
  CHECK((opening_kind='starter' AND starter_id IS NOT NULL AND starter_version IS NOT NULL AND starter_text IS NOT NULL)
     OR (opening_kind='user' AND starter_id IS NULL AND starter_version IS NULL AND starter_text IS NULL)),
  CHECK(parked_starter IS NULL OR (opening_kind='user' AND state='draft')),
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
WHEN NOT EXISTS (SELECT 1 FROM session_deletions WHERE session_id=OLD.session_id) AND
  (OLD.delivery='complete' OR (SELECT state FROM sessions WHERE id=OLD.session_id)='ended') AND NOT
  (OLD.origin='starter' AND OLD.sequence=0 AND
   (SELECT state FROM sessions WHERE id=OLD.session_id)='draft' AND
   NOT EXISTS(SELECT 1 FROM messages WHERE session_id=OLD.session_id AND origin='learner') AND
   NOT EXISTS(SELECT 1 FROM model_requests WHERE session_id=OLD.session_id))
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
  origin TEXT NOT NULL CHECK(origin IN ('seed','generated','detached','intention')),
  attempt_id TEXT REFERENCES starter_renewal_attempts(id),
  ordinal INTEGER CHECK(ordinal IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('active','available','retired','expired','evicted','duplicate','invalidated')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  disposition_at TEXT,
  intention_job_id TEXT UNIQUE REFERENCES intention_question_jobs(id),
  UNIQUE(attempt_id,ordinal),
  CHECK((origin='intention')=(intention_job_id IS NOT NULL)),
  CHECK((origin='seed' AND attempt_id IS NULL AND ordinal IS NULL AND expires_at IS NULL) OR
        (origin='generated' AND attempt_id IS NOT NULL AND ordinal IS NOT NULL AND expires_at IS NOT NULL) OR
        (origin='detached' AND attempt_id IS NULL AND ordinal IS NULL AND expires_at IS NOT NULL) OR
        (origin='intention' AND attempt_id IS NULL AND ordinal IS NULL AND expires_at IS NOT NULL))
);
CREATE INDEX starter_queue_order ON starter_questions(state,created_at,attempt_id,ordinal);
CREATE INDEX starter_question_key ON starter_questions(normalized_text);
CREATE TABLE starter_slots (
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 20),
  question_id TEXT NOT NULL UNIQUE REFERENCES starter_questions(id),
  initialized_at TEXT NOT NULL,
  pending_since TEXT,
  pending_reason TEXT CHECK(pending_reason IN ('answered','skipped','source_changed')),
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
  id,version,text,normalized_text,origin,attempt_id,ordinal,created_at,expires_at,intention_job_id ON starter_questions
WHEN NOT (EXISTS (SELECT 1 FROM starter_catalog_entries WHERE question_id=OLD.id)
  AND NEW.id IS OLD.id AND NEW.origin IS OLD.origin AND NEW.attempt_id IS OLD.attempt_id
  AND NEW.ordinal IS OLD.ordinal AND NEW.created_at IS OLD.created_at
  AND NEW.expires_at IS OLD.expires_at AND NEW.intention_job_id IS OLD.intention_job_id)
AND NOT (OLD.origin='generated' AND NEW.origin='detached' AND NEW.attempt_id IS NULL AND NEW.ordinal IS NULL AND
  NEW.id IS OLD.id AND NEW.version IS OLD.version AND NEW.text IS OLD.text AND NEW.normalized_text IS OLD.normalized_text AND
  NEW.created_at IS OLD.created_at AND NEW.expires_at IS OLD.expires_at AND NEW.intention_job_id IS OLD.intention_job_id AND
  EXISTS (SELECT 1 FROM starter_renewal_attempts a JOIN starter_renewal_jobs j ON j.id=a.job_id
    JOIN session_deletions d ON d.session_id=j.session_id WHERE a.id=OLD.attempt_id))
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

-- Schema v4: explicit whole-chat deletion and restartable external-file cleanup.
-- No foreign key: the marker must survive removal of its owning session.
CREATE TABLE session_deletions (
  session_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  assets TEXT NOT NULL
);

-- Schema v5: explicit entry state, retained draft question and durable entry preference.
CREATE TABLE opening_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  kind TEXT NOT NULL CHECK(kind IN ('starter','user'))
);
INSERT INTO opening_preferences VALUES(1,'starter');
CREATE TRIGGER frozen_opening BEFORE UPDATE OF opening_kind,starter_id,starter_version,starter_text ON sessions
WHEN OLD.state!='draft' AND
  (NEW.opening_kind IS NOT OLD.opening_kind OR NEW.starter_id IS NOT OLD.starter_id OR
   NEW.starter_version IS NOT OLD.starter_version OR NEW.starter_text IS NOT OLD.starter_text)
BEGIN SELECT RAISE(ABORT, 'Conversation opening is immutable'); END;

-- Schema v6: immutable actual learner Send times. Historical rows are unknown.
CREATE TABLE message_times (
  message_id TEXT PRIMARY KEY REFERENCES messages(id),
  sent_at_utc TEXT NOT NULL,
  timezone TEXT,
  utc_offset_minutes INTEGER NOT NULL CHECK(utc_offset_minutes BETWEEN -840 AND 840)
);
CREATE TRIGGER message_time_source BEFORE INSERT ON message_times
WHEN NOT EXISTS(SELECT 1 FROM messages m JOIN sessions s ON s.id=m.session_id
  WHERE m.id=NEW.message_id AND m.role='user' AND m.origin='learner' AND m.delivery='complete' AND s.state!='ended')
BEGIN SELECT RAISE(ABORT, 'Invalid message time source'); END;
CREATE TRIGGER immutable_message_time BEFORE UPDATE ON message_times
BEGIN SELECT RAISE(ABORT, 'Message times are immutable'); END;
CREATE TRIGGER protect_message_time_delete BEFORE DELETE ON message_times
WHEN NOT EXISTS(SELECT 1 FROM messages m JOIN session_deletions d ON d.session_id=m.session_id WHERE m.id=OLD.message_id)
BEGIN SELECT RAISE(ABORT, 'Message times are immutable'); END;
-- next
CREATE TABLE pattern_reports (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,
  selected_attempt_id TEXT,
  FOREIGN KEY(selected_attempt_id,id) REFERENCES pattern_report_attempts(id,report_id) DEFERRABLE INITIALLY DEFERRED
);
-- next
CREATE TABLE pattern_report_sources (
  report_id TEXT NOT NULL REFERENCES pattern_reports(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  analysis_id TEXT,
  evidence_kind TEXT NOT NULL DEFAULT 'grammar' CHECK(evidence_kind IN ('grammar','learner')),
  source_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  CHECK((evidence_kind='grammar' AND analysis_id IS NOT NULL) OR (evidence_kind='learner' AND analysis_id IS NULL)),
  PRIMARY KEY(report_id,session_id),
  UNIQUE(report_id,ordinal)
);
-- next
CREATE INDEX pattern_source_session ON pattern_report_sources(session_id);
-- next
CREATE TABLE pattern_report_attempts (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES pattern_reports(id) ON DELETE CASCADE,
  parent_id TEXT,
  request TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed','cancelled','interrupted')),
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  finished_at TEXT,
  html TEXT,
  html_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  failure TEXT,
  UNIQUE(id,report_id),
  FOREIGN KEY(parent_id,report_id) REFERENCES pattern_report_attempts(id,report_id) DEFERRABLE INITIALLY DEFERRED,
  CHECK((html IS NULL)=(html_hash IS NULL)),
  CHECK(status!='succeeded' OR (html IS NOT NULL AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL))
);
-- next
CREATE UNIQUE INDEX one_pattern_attempt ON pattern_report_attempts((1)) WHERE status IN ('queued','dispatched');
-- next
CREATE TRIGGER immutable_pattern_snapshot BEFORE UPDATE OF id,created_at,fingerprint,snapshot ON pattern_reports
BEGIN SELECT RAISE(ABORT,'Pattern snapshot is immutable'); END;
-- next
CREATE TRIGGER immutable_pattern_selection BEFORE UPDATE OF selected_attempt_id ON pattern_reports
WHEN OLD.selected_attempt_id IS NOT NULL OR NEW.selected_attempt_id IS NULL OR NOT EXISTS(
  SELECT 1 FROM pattern_report_attempts WHERE id=NEW.selected_attempt_id AND report_id=NEW.id AND status='succeeded')
BEGIN SELECT RAISE(ABORT,'Pattern selection is immutable'); END;
-- next
CREATE TRIGGER immutable_pattern_source BEFORE UPDATE ON pattern_report_sources
BEGIN SELECT RAISE(ABORT,'Pattern source is immutable'); END;
-- next
CREATE TRIGGER immutable_pattern_request BEFORE UPDATE OF id,report_id,parent_id,request,request_hash,created_at ON pattern_report_attempts
BEGIN SELECT RAISE(ABORT,'Pattern request is immutable'); END;
-- next
CREATE TRIGGER immutable_pattern_result BEFORE UPDATE ON pattern_report_attempts
WHEN OLD.status NOT IN ('queued','dispatched')
BEGIN SELECT RAISE(ABORT,'Pattern result is immutable'); END;
-- Search schema v8
ALTER TABLE sessions ADD COLUMN search_mode TEXT NOT NULL DEFAULT 'off' CHECK(search_mode IN ('auto','off'));
-- next
CREATE TABLE search_turns (
  user_message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  mode TEXT NOT NULL CHECK(mode IN ('auto','off')),
  input TEXT NOT NULL, input_hash TEXT NOT NULL,
  config TEXT NOT NULL, config_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  decision TEXT CHECK(decision IN ('off','primary','fallback','router_unavailable')),
  permitted INTEGER CHECK(permitted IN (0,1)),
  UNIQUE(user_message_id,session_id),
  FOREIGN KEY(user_message_id,session_id) REFERENCES messages(id,session_id),
  CHECK((decision IS NULL)=(permitted IS NULL)),
  CHECK(mode!='off' OR (decision='off' AND permitted=0))
);
-- next
CREATE TABLE search_router_attempts (
  id TEXT PRIMARY KEY,
  user_message_id TEXT NOT NULL REFERENCES search_turns(user_message_id),
  ordinal INTEGER NOT NULL CHECK(ordinal IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed','interrupted')),
  config TEXT NOT NULL, config_hash TEXT NOT NULL, created_at TEXT NOT NULL,
  dispatched_at TEXT, finished_at TEXT, response_content TEXT,
  metadata TEXT NOT NULL DEFAULT '{}', failure TEXT,
  UNIQUE(user_message_id,ordinal)
);
-- next
CREATE TABLE chat_search_context (
  request_id TEXT PRIMARY KEY,
  user_message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  config TEXT NOT NULL, config_hash TEXT NOT NULL,
  FOREIGN KEY(request_id,session_id) REFERENCES model_requests(id,session_id),
  FOREIGN KEY(user_message_id,session_id) REFERENCES search_turns(user_message_id,session_id)
);
-- next
CREATE TRIGGER immutable_search_turn BEFORE UPDATE OF user_message_id,session_id,mode,input,input_hash,config,config_hash,created_at ON search_turns
BEGIN SELECT RAISE(ABORT,'Search turn is immutable'); END;
-- next
CREATE TRIGGER immutable_search_decision BEFORE UPDATE OF decision,permitted ON search_turns
WHEN OLD.decision IS NOT NULL
BEGIN SELECT RAISE(ABORT,'Search decision is immutable'); END;
-- next
CREATE TRIGGER immutable_search_attempt BEFORE UPDATE OF id,user_message_id,ordinal,config,config_hash,created_at ON search_router_attempts
BEGIN SELECT RAISE(ABORT,'Search attempt is immutable'); END;
-- next
CREATE TRIGGER immutable_search_result BEFORE UPDATE ON search_router_attempts
WHEN OLD.status NOT IN ('queued','dispatched')
BEGIN SELECT RAISE(ABORT,'Search result is immutable'); END;
-- next
CREATE TRIGGER immutable_chat_search_context BEFORE UPDATE ON chat_search_context
BEGIN SELECT RAISE(ABORT,'Chat search context is immutable'); END;

-- Schema v9: one writable memory; character documents remain historical archives.
CREATE TABLE shared_memory (
  id INTEGER PRIMARY KEY CHECK(id=1),
  document TEXT NOT NULL,
  document_hash TEXT NOT NULL
);
CREATE TRIGGER archived_character_memory_update BEFORE UPDATE ON character_memories
BEGIN SELECT RAISE(ABORT, 'Character memories are archived'); END;
CREATE TRIGGER archived_character_memory_insert BEFORE INSERT ON character_memories
BEGIN SELECT RAISE(ABORT, 'Character memories are archived'); END;
CREATE TRIGGER archived_character_memory_delete BEFORE DELETE ON character_memories
BEGIN SELECT RAISE(ABORT, 'Character memories are archived'); END;

-- Intention questions and deferred starter preparation, schema v10.
CREATE TABLE starter_preparations (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, deadline TEXT NOT NULL, source_hash TEXT NOT NULL,
  config TEXT NOT NULL, config_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('waiting','released')), reason TEXT
);
CREATE TRIGGER immutable_starter_preparation BEFORE UPDATE OF session_id,created_at,source_hash,config,config_hash ON starter_preparations
BEGIN SELECT RAISE(ABORT, 'Starter preparation sources are immutable'); END;
CREATE TABLE intention_question_state (
  item_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>0), text TEXT, text_hash TEXT,
  last_question TEXT,
  CHECK((text IS NULL)=(text_hash IS NULL))
);
CREATE TABLE intention_question_jobs (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES intention_question_state(item_id),
  epoch INTEGER NOT NULL, text_hash TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  input_json TEXT NOT NULL, input_hash TEXT NOT NULL, config TEXT NOT NULL, config_hash TEXT NOT NULL,
  created_at TEXT NOT NULL, deadline TEXT NOT NULL, run INTEGER NOT NULL DEFAULT 1 CHECK(run>0),
  state TEXT NOT NULL CHECK(state IN ('pending','running','received','accepted','duplicate','failed','interrupted','superseded')),
  question_id TEXT UNIQUE REFERENCES starter_questions(id),
  UNIQUE(item_id,epoch)
);
CREATE TRIGGER immutable_intention_job BEFORE UPDATE OF id,item_id,epoch,text_hash,input_json,input_hash,config,config_hash,created_at ON intention_question_jobs
BEGIN SELECT RAISE(ABORT, 'Intention job sources are immutable'); END;
CREATE TABLE intention_question_attempts (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES intention_question_jobs(id), run INTEGER NOT NULL,
  route INTEGER NOT NULL CHECK(route BETWEEN 0 AND 2),
  status TEXT NOT NULL CHECK(status IN ('dispatched','received','succeeded','failed','interrupted')),
  dispatched_at TEXT NOT NULL, finished_at TEXT, response_content TEXT, metadata TEXT NOT NULL DEFAULT '{}', failure TEXT,
  UNIQUE(job_id,run,route)
);
CREATE UNIQUE INDEX one_live_intention_attempt ON intention_question_attempts(job_id) WHERE status IN ('dispatched','received');
CREATE TRIGGER immutable_intention_attempt BEFORE UPDATE OF id,job_id,run,route,dispatched_at ON intention_question_attempts
BEGIN SELECT RAISE(ABORT, 'Intention attempt sources are immutable'); END;

-- next
-- Schema v11: user-selected conversation bookmarks, separate from source evidence.
CREATE TABLE session_bookmarks (
  session_id TEXT NOT NULL PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
);

-- Schema v12: explicit same-session partner selection, separate from initial routes.
CREATE TABLE session_partner_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  current_character TEXT NOT NULL,
  current_model TEXT NOT NULL,
  pending_operation_id TEXT,
  FOREIGN KEY(pending_operation_id,session_id) REFERENCES partner_selection_operations(id,session_id)
);
CREATE TABLE partner_selection_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  revision INTEGER NOT NULL,
  choice TEXT,
  excluded_model TEXT NOT NULL,
  source_sequence INTEGER,
  source_hash TEXT,
  config TEXT,
  config_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','routing','ready','failed','completed','superseded')),
  selected_character TEXT,
  selected_model TEXT,
  decision TEXT,
  router_request_id TEXT,
  chat_request_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(id,session_id),
  UNIQUE(session_id,revision),
  FOREIGN KEY(router_request_id,session_id) REFERENCES model_requests(id,session_id),
  FOREIGN KEY(chat_request_id,session_id) REFERENCES model_requests(id,session_id)
);
CREATE TRIGGER immutable_partner_selection BEFORE UPDATE OF id,session_id,revision,choice,excluded_model,created_at ON partner_selection_operations
BEGIN SELECT RAISE(ABORT, 'Partner selection identity is immutable'); END;
CREATE TRIGGER frozen_partner_selection BEFORE UPDATE OF source_sequence,source_hash,config,config_hash ON partner_selection_operations
WHEN OLD.source_sequence IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Partner selection input is immutable'); END;

-- Schema v13: saved explanations with immutable source and request provenance.
CREATE TABLE explanations (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  target_key TEXT NOT NULL, source_json TEXT NOT NULL, request_body TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','interrupted')),
  content TEXT, metadata TEXT NOT NULL DEFAULT '{}', failure TEXT, created_at TEXT NOT NULL,
  UNIQUE(session_id,message_id,target_key)
);
CREATE TRIGGER immutable_explanation_source BEFORE UPDATE OF id,session_id,message_id,target_key,source_json,request_body,created_at ON explanations
BEGIN SELECT RAISE(ABORT, 'Explanation source is immutable'); END;
CREATE TABLE explanation_attempts (
  id TEXT PRIMARY KEY, explanation_id TEXT NOT NULL REFERENCES explanations(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending','ready','failed','interrupted')),
  content TEXT, metadata TEXT NOT NULL DEFAULT '{}', failure TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE UNIQUE INDEX one_pending_explanation ON explanation_attempts(explanation_id) WHERE state='pending';
CREATE TRIGGER immutable_explanation_attempt BEFORE UPDATE OF id,explanation_id,created_at ON explanation_attempts
BEGIN SELECT RAISE(ABORT, 'Explanation attempt identity is immutable'); END;
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

-- Schema 19 installs the reusable English-only offline starter catalog.
CREATE TABLE starter_catalog_install (
  catalog_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  installed_count INTEGER NOT NULL CHECK(installed_count > 0)
, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0));
CREATE TABLE starter_catalog_entries (
  question_id TEXT PRIMARY KEY REFERENCES starter_questions(id),
  catalog_id TEXT NOT NULL REFERENCES starter_catalog_install(catalog_id),
  source_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  activity TEXT NOT NULL,
  answer_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(answer_count)='integer' AND answer_count >= 0),
  skip_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(skip_count)='integer' AND skip_count >= 0),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK(eligible IN (0,1)),
  UNIQUE(catalog_id,source_id)
);
CREATE INDEX starter_catalog_eligible ON starter_catalog_entries(catalog_id,eligible);

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

CREATE TABLE starter_catalog_aliases (
  legacy_id TEXT PRIMARY KEY REFERENCES starter_questions(id),
  question_id TEXT NOT NULL REFERENCES starter_catalog_entries(question_id)
);

-- Global memory preference and first conversation dispatch policy.
CREATE TABLE memory_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>=0)
);
INSERT INTO memory_preferences VALUES(1,1,0);
CREATE TABLE session_memory_policy (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  first_enabled INTEGER NOT NULL CHECK(first_enabled IN (0,1)),
  updates_disabled INTEGER NOT NULL CHECK(updates_disabled IN (0,1))
);

-- Public schema 26 -> 27: effective provider request evidence; historical rows remain NULL.
ALTER TABLE model_requests ADD COLUMN provider_request TEXT;
ALTER TABLE search_router_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE pattern_report_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE memory_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE memory_cleanup_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE explanation_attempts ADD COLUMN provider_request TEXT;

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
CREATE TABLE memory_retired_jobs (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  evidence TEXT NOT NULL
);
CREATE INDEX memory_add_pending ON memory_add_jobs(ordinal) WHERE state NOT IN ('completed','skipped');
CREATE TRIGGER immutable_memory_add_attempt BEFORE UPDATE OF id,job_id,body,body_hash,created_at ON memory_add_attempts
BEGIN SELECT RAISE(ABORT,'immutable memory ADD attempt'); END;

-- Public schema 29 -> 30: preserved FIFO originals and local derived memory.
-- Provenance survives source-chat deletion. Unknown historical IDs remain NULL.
ALTER TABLE memory_item_metadata RENAME TO memory_item_metadata_v29;
CREATE TABLE memory_item_metadata (
  id TEXT PRIMARY KEY,
  source_order INTEGER NOT NULL, item_index INTEGER NOT NULL,
  source_message_id TEXT, source_session_id TEXT,
  observed_at TEXT, origin TEXT NOT NULL CHECK(origin IN ('legacy','add','manual')),
  edited_at TEXT,
  UNIQUE(source_order,item_index)
);
INSERT INTO memory_item_metadata(id,source_order,item_index,source_message_id,source_session_id,observed_at,origin)
  SELECT id,source_order,item_index,source_message_id,source_session_id,observed_at,origin FROM memory_item_metadata_v29;
DROP TABLE memory_item_metadata_v29;

CREATE TABLE cold_mutations (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('archive','delete','repair'))
);
CREATE INDEX cold_mutations_item ON cold_mutations(memory_id,revision);
CREATE TABLE cold_memories (
  id TEXT PRIMARY KEY, text TEXT NOT NULL, text_hash TEXT NOT NULL,
  source_order INTEGER NOT NULL, item_index INTEGER NOT NULL,
  source_message_id TEXT, source_session_id TEXT,
  observed_at TEXT, edited_at TEXT, archived_at TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('legacy','add','manual')),
  time_basis TEXT NOT NULL CHECK(time_basis IN ('source_message','manual_edit','unknown')),
  archive_revision INTEGER NOT NULL UNIQUE REFERENCES cold_mutations(revision)
);
CREATE INDEX cold_memory_order ON cold_memories(source_order,item_index,id);
CREATE TRIGGER immutable_cold_original BEFORE UPDATE ON cold_memories
BEGIN SELECT RAISE(ABORT,'immutable COLD original'); END;
CREATE TABLE cold_revocations (
  memory_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL REFERENCES cold_mutations(revision)
);
CREATE TABLE embedding_spaces (
  id TEXT PRIMARY KEY, manifest TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions>0),
  created_at TEXT NOT NULL
);
CREATE TRIGGER immutable_embedding_space BEFORE UPDATE ON embedding_spaces
BEGIN SELECT RAISE(ABORT,'immutable embedding space'); END;
CREATE TABLE cold_embeddings (
  memory_id TEXT NOT NULL REFERENCES cold_memories(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id),
  source_hash TEXT NOT NULL, input_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','failed')),
  vector BLOB, vector_hash TEXT, chunk_count INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  failure TEXT, lease TEXT,
  PRIMARY KEY(memory_id,space_id),
  CHECK((state='ready' AND vector IS NOT NULL AND vector_hash IS NOT NULL AND input_hash IS NOT NULL AND chunk_count>0) OR state!='ready'),
  CHECK((state='running' AND lease IS NOT NULL) OR (state!='running' AND lease IS NULL))
);
CREATE INDEX cold_embedding_queue ON cold_embeddings(space_id,state,memory_id);
CREATE TABLE cluster_generations (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES embedding_spaces(id),
  policy TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('building','active','retired','failed')),
  scan_revision INTEGER NOT NULL DEFAULT 0,
  completed_revision INTEGER NOT NULL DEFAULT 0,
  next_assignment INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, failure TEXT,
  UNIQUE(id,space_id)
);
CREATE UNIQUE INDEX cold_one_active_generation ON cluster_generations(state) WHERE state='active';
CREATE TABLE cold_clusters (
  id TEXT NOT NULL, generation_id TEXT NOT NULL REFERENCES cluster_generations(id) ON DELETE CASCADE,
  sum_vector BLOB NOT NULL, centroid BLOB NOT NULL, anchor_id TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK(item_count>0),
  session_count INTEGER NOT NULL CHECK(session_count>=0),
  cohesion REAL NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','repairing')),
  anchor_cursor TEXT, anchor_candidate TEXT, anchor_similarity REAL,
  PRIMARY KEY(id,generation_id)
);
CREATE TABLE cold_memberships (
  generation_id TEXT NOT NULL, space_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES cold_memories(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('assigned','excluded')),
  cluster_id TEXT, assignment_seq INTEGER, failure TEXT,
  source_revision INTEGER NOT NULL,
  PRIMARY KEY(generation_id,memory_id),
  FOREIGN KEY(generation_id,space_id) REFERENCES cluster_generations(id,space_id) ON DELETE CASCADE,
  FOREIGN KEY(memory_id,space_id) REFERENCES cold_embeddings(memory_id,space_id) ON DELETE CASCADE,
  FOREIGN KEY(cluster_id,generation_id) REFERENCES cold_clusters(id,generation_id),
  CHECK((state='assigned' AND cluster_id IS NOT NULL AND assignment_seq IS NOT NULL AND failure IS NULL)
     OR (state='excluded' AND cluster_id IS NULL AND assignment_seq IS NULL AND failure IS NOT NULL))
);
CREATE INDEX cold_group_members ON cold_memberships(generation_id,cluster_id,state,memory_id);
CREATE TABLE cold_cluster_sessions (
  generation_id TEXT NOT NULL, cluster_id TEXT NOT NULL, source_session_id TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK(item_count>0),
  PRIMARY KEY(generation_id,cluster_id,source_session_id),
  FOREIGN KEY(cluster_id,generation_id) REFERENCES cold_clusters(id,generation_id) ON DELETE CASCADE
);
CREATE TABLE cold_render_metadata (
  memory_id TEXT NOT NULL REFERENCES cold_memories(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL, text_hash TEXT NOT NULL,
  rendered_length INTEGER NOT NULL CHECK(rendered_length>0),
  PRIMARY KEY(memory_id,policy_version)
);
CREATE TABLE session_cold_recollections (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  selection TEXT NOT NULL, selection_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id,revision)
);
CREATE TRIGGER immutable_cold_recollection BEFORE UPDATE ON session_cold_recollections
BEGIN SELECT RAISE(ABORT,'immutable COLD recollection revision'); END;

ALTER TABLE sessions ADD COLUMN reply_context_revision INTEGER NOT NULL DEFAULT 0 CHECK(reply_context_revision >= 0);
ALTER TABLE sessions ADD COLUMN last_reply_context_operation TEXT;
CREATE TABLE reply_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL CHECK(mode IN ('standard','one_point'))
);
INSERT INTO reply_preferences(id,mode) VALUES(1,'one_point');

CREATE TABLE search_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL CHECK(mode IN ('auto','off'))
);
INSERT INTO search_preferences(id,mode) VALUES(1,'auto');

-- Public schema 32 -> 33: derived vectors for request-local associative recall.
-- The authoritative text remains the active memory document or COLD original.
CREATE TABLE associative_embeddings (
  memory_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES embedding_spaces(id),
  source_hash TEXT NOT NULL, input_hash TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','running','ready','failed')),
  vector BLOB, vector_hash TEXT, chunk_count INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), lease TEXT, failure TEXT,
  CHECK((state='ready' AND vector IS NOT NULL AND vector_hash IS NOT NULL AND input_hash IS NOT NULL AND chunk_count IS NOT NULL) OR state!='ready'),
  CHECK((state='running' AND lease IS NOT NULL) OR (state!='running' AND lease IS NULL))
);
CREATE INDEX associative_embedding_queue ON associative_embeddings(space_id,state,memory_id);
