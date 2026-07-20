-- Phase 2 live Mezzanine lookup (Notion 39d637c5, card 174): a show in
-- NEITHER catalog was previously a dead end for the Add-show search and the
-- import "not on Broadway Scorecard" list. This table stores the metadata a
-- user selects from a live mezzanine-search result so cards/pages can render
-- it immediately, before the nightly resolver (resolve-unmatched-imports.js)
-- promotes it into diary-shows.json.
--
-- id is the SAME deterministic <slug>-<category>-mz<prodObjectId> pattern
-- buildDiarySlug() produces (scripts/lib/mezzanine-classify.js) — a review or
-- watchlist row written against a stub's id must still resolve after the
-- resolver promotes it, since the promoted diary-shows.json entry reuses this
-- exact id.
CREATE TABLE IF NOT EXISTS user_show_stubs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  venue TEXT,
  city TEXT,
  category TEXT NOT NULL,
  opening_date DATE,
  poster_url TEXT,
  -- Mezzanine Production objectId — the resolver re-fetches this (include
  -- show,theater) to pick up ratingsCount/averageRating for diary-shows.json
  -- ranking, rather than trusting client-supplied numbers.
  mezz_prod_id TEXT NOT NULL,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_show_stubs_mezz_prod_id
  ON user_show_stubs (mezz_prod_id);

-- RLS: signed-in users can create a stub for a show they just picked from
-- live search; SELECT is public — stub cards/pages render for signed-out
-- visitors the same as any other diary-only show (display metadata only, no
-- PII beyond created_by which no read policy exposes).
ALTER TABLE user_show_stubs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "insert own show stub" ON user_show_stubs
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = created_by);

CREATE POLICY "public read show stubs" ON user_show_stubs
  FOR SELECT TO anon, authenticated
  USING (true);
