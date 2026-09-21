-- Public schema 45 -> 46: frozen date provenance for new conversations only.
CREATE TABLE session_date_contexts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  context TEXT NOT NULL,
  context_hash TEXT NOT NULL
);
CREATE TRIGGER immutable_session_date_context BEFORE UPDATE ON session_date_contexts
BEGIN SELECT RAISE(ABORT,'immutable session date context'); END;
