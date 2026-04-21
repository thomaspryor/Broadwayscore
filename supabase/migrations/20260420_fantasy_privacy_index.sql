-- Fantasy League — PII fix + leaderboard index
-- (1) Close PII leak: anyone with the public anon key could hit
--     /rest/v1/fantasy_entries and read raw emails + tiebreakers. Drop the
--     public SELECT policy and expose a minimal view with server-side-masked
--     emails and no tiebreakers.
-- (2) Add (season, league_name) index so per-league leaderboard queries
--     remain fast as entry count grows toward 1000.

-- Server-side email masking (matches src/config/fantasy.ts maskEmail).
CREATE OR REPLACE FUNCTION mask_email(email_in TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN email_in IS NULL OR position('@' IN email_in) = 0 THEN NULL
    ELSE substr(email_in, 1, 1) || '***' || substr(email_in, position('@' IN email_in))
  END
$$ LANGUAGE SQL IMMUTABLE;

-- Public-safe view: no email, no tiebreakers. display_email is pre-masked.
CREATE OR REPLACE VIEW fantasy_entries_public AS
SELECT
  id,
  mask_email(email) AS display_email,
  team_name,
  league_name,
  picks,
  total_cost,
  picks_prices_snapshot,
  price_version_at_submission,
  season,
  created_at
FROM fantasy_entries;

-- Views inherit the caller's permissions by default on newer Postgres.
-- Force security_invoker so RLS on the underlying table is bypassed and
-- anon can SELECT from the view without SELECT on the base table.
ALTER VIEW fantasy_entries_public SET (security_invoker = false);

GRANT SELECT ON fantasy_entries_public TO anon;

-- Remove the overly permissive base-table SELECT policy. anon can still
-- INSERT (required for draft submission); reads go through the view.
DROP POLICY IF EXISTS "Anyone can read fantasy entries" ON fantasy_entries;

-- Leaderboard hot-path index.
CREATE INDEX IF NOT EXISTS idx_fantasy_entries_season_league
  ON fantasy_entries(season, league_name);
