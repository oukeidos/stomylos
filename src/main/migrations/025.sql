-- Admit direct user memory edits and fresh flat-memory preparation for untouched
-- legacy sessions. Existing JSON fields represent both already-supported formats.
-- Historical snapshots/requests, active sessions and pending jobs stay immutable.
SELECT 1;
