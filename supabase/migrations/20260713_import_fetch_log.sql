-- Rate-limit + abuse-audit log for the show-score-proxy edge function
-- (plan-review consensus P0: JWT alone lets any signed-in user scrape
-- arbitrary Show Score profiles through our egress; this table backs a
-- per-user hourly cap and records user_id+slug for fan-out anomaly checks).
CREATE TABLE IF NOT EXISTS import_fetch_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL,
  slug TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_fetch_log_user_time
  ON import_fetch_log (user_id, created_at DESC);
-- RLS on with no policies: only the service role (edge function) can touch it.
ALTER TABLE import_fetch_log ENABLE ROW LEVEL SECURITY;
