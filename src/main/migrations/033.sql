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
