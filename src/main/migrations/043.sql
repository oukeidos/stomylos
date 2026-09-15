-- Public schema 42 -> 43: durable post-extraction source linking.
CREATE TABLE memory_source_checkpoints (
  job_id INTEGER PRIMARY KEY REFERENCES memory_add_jobs(ordinal) ON DELETE CASCADE,
  records TEXT NOT NULL, records_hash TEXT NOT NULL, projection TEXT, projection_hash TEXT
);
CREATE TRIGGER immutable_memory_source_checkpoint BEFORE UPDATE OF job_id,records,records_hash ON memory_source_checkpoints
BEGIN SELECT RAISE(ABORT,'immutable memory source checkpoint'); END;
CREATE TRIGGER immutable_memory_source_projection BEFORE UPDATE OF projection,projection_hash ON memory_source_checkpoints WHEN OLD.projection IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable memory source projection'); END;
CREATE TABLE memory_source_batches (
  job_id INTEGER NOT NULL REFERENCES memory_source_checkpoints(job_id) ON DELETE CASCADE,
  batch_index INTEGER NOT NULL, body TEXT NOT NULL, body_hash TEXT NOT NULL,
  sources TEXT, sources_hash TEXT,
  PRIMARY KEY(job_id,batch_index)
);
CREATE TRIGGER immutable_memory_source_batch BEFORE UPDATE OF job_id,batch_index,body,body_hash ON memory_source_batches
BEGIN SELECT RAISE(ABORT,'immutable memory source batch'); END;
CREATE TRIGGER immutable_memory_source_result BEFORE UPDATE OF sources,sources_hash ON memory_source_batches WHEN OLD.sources IS NOT NULL
BEGIN SELECT RAISE(ABORT,'immutable memory source result'); END;
CREATE TABLE memory_source_attempts (
  attempt_id TEXT PRIMARY KEY REFERENCES memory_add_attempts(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL, batch_index INTEGER NOT NULL,
  FOREIGN KEY(job_id,batch_index) REFERENCES memory_source_batches(job_id,batch_index) ON DELETE CASCADE
);
CREATE TRIGGER immutable_memory_source_attempt BEFORE UPDATE ON memory_source_attempts
BEGIN SELECT RAISE(ABORT,'immutable memory source attempt'); END;
