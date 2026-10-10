-- Rate-limit + spend log for the theatr-screenshot-import edge function
-- (BRO-4618). A sibling table to import_fetch_log and mezzanine_search_log,
-- not a shared column: show-score-proxy counts every import_fetch_log row a
-- user has, so Theatr batches logged there would eat its hourly budget. Each
-- row is one model call (up to 6 screenshots), counted per user per hour and
-- across all users per day as a spend ceiling.
CREATE TABLE IF NOT EXISTS theatr_screenshot_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL,
  image_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_theatr_screenshot_log_user_time
  ON theatr_screenshot_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_theatr_screenshot_log_time
  ON theatr_screenshot_log (created_at DESC);
-- RLS on with no policies: only the service role (edge function) can touch it.
ALTER TABLE theatr_screenshot_log ENABLE ROW LEVEL SECURITY;
