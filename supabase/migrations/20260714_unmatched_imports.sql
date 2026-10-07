-- Self-heal loop for import matching (Notion 39d637c5): every unmatched or
-- low-confidence row from a My Shows import gets logged here so a nightly
-- resolver can look it up on Mezzanine and grow diary-shows.json instead of
-- the catalog staying frozen at its March 2026 snapshot forever.
CREATE TABLE IF NOT EXISTS unmatched_imports (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  venue TEXT,
  date_seen DATE,
  -- Mezzanine Show class objectId (entry.show.id from the export) — the
  -- resolver looks up Productions pointing at this Show. NULL for Show Score
  -- rows, which only carry a title.
  mezz_show_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set once the resolver successfully appends a diary-shows.json entry for
  -- this row; left NULL rows are what the resolver still has to try.
  resolved_at TIMESTAMPTZ,
  resolved_show_id TEXT,
  -- Set on every resolver pass over a row, whether or not it resolved — lets
  -- the resolver skip rows it already gave up on instead of re-querying
  -- Mezzanine for the same dead end every night.
  last_attempted_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_unmatched_imports_unresolved
  ON unmatched_imports (last_attempted_at)
  WHERE resolved_at IS NULL;

-- RLS: signed-in users can log their own unmatched rows (fire-and-forget from
-- the import modal); only the service role (nightly resolver) reads/updates.
ALTER TABLE unmatched_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insert own unmatched imports" ON unmatched_imports
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);
