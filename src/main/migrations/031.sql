ALTER TABLE sessions ADD COLUMN reply_context_revision INTEGER NOT NULL DEFAULT 0 CHECK(reply_context_revision >= 0);
ALTER TABLE sessions ADD COLUMN last_reply_context_operation TEXT;
CREATE TABLE reply_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL CHECK(mode IN ('standard','one_point'))
);
INSERT INTO reply_preferences(id,mode) VALUES(1,'one_point');
