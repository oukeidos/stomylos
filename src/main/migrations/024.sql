-- Admit forward catalog revisions; preserve lineage and historical evidence.
ALTER TABLE starter_catalog_install ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
CREATE TABLE starter_catalog_aliases (
  legacy_id TEXT PRIMARY KEY REFERENCES starter_questions(id),
  question_id TEXT NOT NULL REFERENCES starter_catalog_entries(question_id)
);
INSERT INTO starter_catalog_aliases
SELECT old.id,c.question_id FROM starter_questions old
JOIN starter_questions current ON current.normalized_text=old.normalized_text
JOIN starter_catalog_entries c ON c.question_id=current.id
WHERE old.id NOT IN (SELECT question_id FROM starter_catalog_entries);
DROP TRIGGER immutable_starter_question;
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
