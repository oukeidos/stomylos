-- Public schema 28 -> 29: remove the previous-memory archive only.
-- The standard verified pre-migration backup retains the original database.
DROP TRIGGER immutable_memory_cutover;
DROP TABLE memory_cutover_archive;
