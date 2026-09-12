CREATE TABLE search_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  mode TEXT NOT NULL CHECK(mode IN ('auto','off'))
);
-- Use the latest chat's saved setting as the upgrade baseline, without changing chats.
INSERT INTO search_preferences(id,mode)
VALUES(1,COALESCE((SELECT search_mode FROM sessions ORDER BY created_at DESC,rowid DESC LIMIT 1),'auto'));
-- A previously saved draft choice now counts even if the draft was never sent.
UPDATE reply_preferences SET mode=COALESCE(
  (SELECT json_extract(chat_config,'$.reply_context.mode') FROM sessions
   WHERE last_reply_context_operation IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1),mode);
