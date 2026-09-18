-- Public schema 43 -> 44: distinguish expression suggestions from grammar reports.
-- Existing attempt html/html_hash columns retain their physical names; for
-- expression reports they hold raw JSON and its hash, never rendered as HTML.
ALTER TABLE pattern_reports ADD COLUMN report_type TEXT NOT NULL DEFAULT 'grammar' CHECK(report_type IN ('grammar','expression'));
CREATE TRIGGER immutable_report_type BEFORE UPDATE OF report_type ON pattern_reports
BEGIN SELECT RAISE(ABORT,'Report type is immutable'); END;
