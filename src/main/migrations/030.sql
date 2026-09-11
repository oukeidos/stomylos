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
