-- Public schema 39 -> 40: local word-cloud visibility preference.
CREATE TABLE word_cloud_preferences (
  id INTEGER PRIMARY KEY CHECK(id=1),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
INSERT INTO word_cloud_preferences VALUES(1,1);
