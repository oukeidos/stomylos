-- Public schema 26 -> 27: effective provider request evidence; historical rows remain NULL.
ALTER TABLE model_requests ADD COLUMN provider_request TEXT;
ALTER TABLE search_router_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE pattern_report_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE memory_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE memory_cleanup_attempts ADD COLUMN provider_request TEXT;
ALTER TABLE explanation_attempts ADD COLUMN provider_request TEXT;
