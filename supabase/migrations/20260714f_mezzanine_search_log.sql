-- Rate-limit + abuse-audit log for the mezzanine-search edge function. A
-- sibling table to import_fetch_log (not a shared `source` column) so a
-- user's live-catalog searches and their Show Score profile imports draw
-- from independent hourly budgets instead of contending for one counter.
CREATE TABLE IF NOT EXISTS mezzanine_search_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL,
  query TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mezzanine_search_log_user_time
  ON mezzanine_search_log (user_id, created_at DESC);
-- RLS on with no policies: only the service role (edge function) can touch it.
ALTER TABLE mezzanine_search_log ENABLE ROW LEVEL SECURITY;
