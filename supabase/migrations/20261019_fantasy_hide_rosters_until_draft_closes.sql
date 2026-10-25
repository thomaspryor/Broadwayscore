-- Fantasy League: nobody can read another team's picks while the draft is open.
--
-- The game is guessing. The app reads Supabase with the public anon key (it is
-- in every page's JavaScript), so hiding picks in our API alone would leave
-- /rest/v1/fantasy_entries_public and the two RPCs below readable by anyone.
-- Both now return `picks` as N copies of the text 'hidden' (N = roster size, so
-- counts and 'has this team drafted' still work), no price snapshot (it names
-- the picked shows) and no total_cost (it narrows the roster) until the draft
-- deadline. Everything else is unchanged. isValidLeaderboardEntry accepts the
-- all-'hidden' roster (src/lib/data-fantasy.ts, scripts/lib/fantasy-helpers.js).
--
-- THE DEADLINE BELOW MUST EQUAL draftDeadline IN src/config/fantasy-season.json.
-- tests/unit/fantasy-roster-privacy.test.ts fails when they differ, so a new
-- season cannot ship with a stale date.
--
-- Rollback: re-run the SELECT lists of 20260422b_fantasy_entries_pii_fix.sql
-- (fantasy_entries_masked) and 20260821_fantasy_find_by_email.sql.

CREATE OR REPLACE FUNCTION public.fantasy_entries_masked()
RETURNS TABLE (
  id                          uuid,
  display_email               text,
  team_name                   text,
  league_name                 text,
  picks                       jsonb,
  total_cost                  integer,
  picks_prices_snapshot       jsonb,
  price_version_at_submission text,
  season                      text,
  created_at                  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT id,
         public.mask_email(email) AS display_email,
         team_name,
         league_name,
         CASE WHEN now() > timestamptz '2026-11-30T04:59:59Z' THEN picks
              WHEN jsonb_typeof(picks) = 'array'
                THEN (SELECT COALESCE(jsonb_agg('hidden'::text), '[]'::jsonb) FROM jsonb_array_elements(picks))
              ELSE '[]'::jsonb END AS picks,
         CASE WHEN now() > timestamptz '2026-11-30T04:59:59Z' THEN total_cost ELSE NULL END AS total_cost,
         CASE WHEN now() > timestamptz '2026-11-30T04:59:59Z' THEN picks_prices_snapshot ELSE NULL END AS picks_prices_snapshot,
         price_version_at_submission,
         season,
         created_at
    FROM public.fantasy_entries
$function$;

CREATE OR REPLACE FUNCTION public.find_fantasy_entry_by_email(p_email text, p_season text)
RETURNS TABLE (
  id                          uuid,
  display_email               text,
  team_name                   text,
  league_name                 text,
  picks                       jsonb,
  total_cost                  integer,
  picks_prices_snapshot       jsonb,
  price_version_at_submission text,
  season                      text,
  created_at                  timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT id,
         public.mask_email(email) AS display_email,
         team_name,
         league_name,
         CASE WHEN now() > timestamptz '2026-11-30T04:59:59Z' THEN picks
              WHEN jsonb_typeof(picks) = 'array'
                THEN (SELECT COALESCE(jsonb_agg('hidden'::text), '[]'::jsonb) FROM jsonb_array_elements(picks))
              ELSE '[]'::jsonb END AS picks,
         CASE WHEN now() > timestamptz '2026-11-30T04:59:59Z' THEN total_cost ELSE NULL END AS total_cost,
         CASE WHEN now() > timestamptz '2026-11-30T04:59:59Z' THEN picks_prices_snapshot ELSE NULL END AS picks_prices_snapshot,
         price_version_at_submission,
         season,
         created_at
    FROM public.fantasy_entries
   WHERE lower(email) = lower(p_email)
     AND season = p_season
   LIMIT 1
$function$;

GRANT EXECUTE ON FUNCTION public.fantasy_entries_masked() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_fantasy_entry_by_email(text, text) TO anon, authenticated;
