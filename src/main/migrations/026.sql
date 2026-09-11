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
INSERT INTO session_memory_policy
SELECT DISTINCT session_id,1,0 FROM model_requests WHERE role='chat' AND dispatched_at IS NOT NULL;
