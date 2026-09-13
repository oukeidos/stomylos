-- Public schema 37 -> 38: session ADD applies only to newly created conversations.
ALTER TABLE sessions ADD COLUMN memory_add_scope TEXT NOT NULL DEFAULT 'turn' CHECK(memory_add_scope IN ('turn','session'));
CREATE TRIGGER immutable_memory_add_scope BEFORE UPDATE OF memory_add_scope ON sessions
BEGIN SELECT RAISE(ABORT, 'Immutable memory ADD scope'); END;
ALTER TABLE memory_add_jobs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'turn' CHECK(source_kind IN ('turn','session'));
ALTER TABLE memory_add_jobs ADD COLUMN source_manifest TEXT;
CREATE UNIQUE INDEX memory_add_one_session ON memory_add_jobs(session_id) WHERE source_kind='session';
CREATE TRIGGER immutable_memory_add_manifest BEFORE UPDATE OF source_kind,source_manifest ON memory_add_jobs
BEGIN SELECT RAISE(ABORT, 'Immutable memory ADD source'); END;
