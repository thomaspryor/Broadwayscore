-- Fantasy Leagues table
-- Stores named private leagues identified by a short code.
-- The code is stored directly in fantasy_entries.league_name for compatibility with existing filtering.

CREATE TABLE IF NOT EXISTS fantasy_leagues (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text UNIQUE NOT NULL,          -- 6-char nanoid, URL-safe, lowercase
  name        text NOT NULL,                  -- human-readable display name
  created_by  text NOT NULL,                  -- email (unverified, display only)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fantasy_leagues_code ON fantasy_leagues (code);
