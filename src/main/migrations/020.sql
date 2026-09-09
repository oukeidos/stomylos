-- Public schema 19 -> 20: direct report sources; historical snapshots remain immutable.
DROP TRIGGER immutable_pattern_source;
DROP INDEX pattern_source_session;
ALTER TABLE pattern_report_sources RENAME TO pattern_report_sources_v19;
CREATE TABLE pattern_report_sources (
  report_id TEXT NOT NULL REFERENCES pattern_reports(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  analysis_id TEXT,
  evidence_kind TEXT NOT NULL DEFAULT 'grammar' CHECK(evidence_kind IN ('grammar','learner')),
  source_hash TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  CHECK((evidence_kind='grammar' AND analysis_id IS NOT NULL) OR (evidence_kind='learner' AND analysis_id IS NULL)),
  PRIMARY KEY(report_id,session_id),
  UNIQUE(report_id,ordinal)
);

CREATE INDEX pattern_source_session ON pattern_report_sources(session_id);
INSERT INTO pattern_report_sources(report_id,session_id,analysis_id,evidence_kind,source_hash,ordinal)
SELECT report_id,session_id,analysis_id,'grammar',source_hash,ordinal FROM pattern_report_sources_v19;
DROP TABLE pattern_report_sources_v19;
CREATE TRIGGER immutable_pattern_source BEFORE UPDATE ON pattern_report_sources
BEGIN SELECT RAISE(ABORT,'Pattern source is immutable'); END;

-- Old unrequested automatic work is now available only on explicit action.
UPDATE sessions SET analysis_state='none' WHERE state='ended' AND analysis_state='pending'
AND NOT EXISTS(SELECT 1 FROM model_requests r WHERE r.session_id=sessions.id AND r.role='grammar');
