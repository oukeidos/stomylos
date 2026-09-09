-- Schema 19 installs the reusable English-only offline starter catalog.
CREATE TABLE starter_catalog_install (
  catalog_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  installed_count INTEGER NOT NULL CHECK(installed_count > 0)
);
CREATE TABLE starter_catalog_entries (
  question_id TEXT PRIMARY KEY REFERENCES starter_questions(id),
  catalog_id TEXT NOT NULL REFERENCES starter_catalog_install(catalog_id),
  source_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  activity TEXT NOT NULL,
  answer_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(answer_count)='integer' AND answer_count >= 0),
  skip_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(skip_count)='integer' AND skip_count >= 0),
  eligible INTEGER NOT NULL DEFAULT 1 CHECK(eligible IN (0,1)),
  UNIQUE(catalog_id,source_id)
);
CREATE INDEX starter_catalog_eligible ON starter_catalog_entries(catalog_id,eligible);
