-- Fantasy League — "find my team" by exact email (BRO-760 acceptance gap)
--
-- The leaderboard is only filterable by league name today; there is no way
-- to look up your own entry by the email you drafted with. Adding a plain
-- SELECT ... WHERE email = X on the base table (or widening the public view)
-- would re-open the PII leak fixed in 20260420_fantasy_privacy_index.sql /
-- 20260422b_fantasy_entries_pii_fix.sql (raw emails readable via
-- /rest/v1/fantasy_entries). Instead: a SECURITY DEFINER function that takes
-- an exact email, does the lookup itself (bypassing RLS on the base table
-- the way fantasy_entries_masked() already does), and returns at most one
-- row shaped like fantasy_entries_public — display_email stays masked, no
-- raw email or tiebreakers leave the function. No LIKE/ILIKE, no listing:
-- callers can only confirm "does this exact email have an entry" one at a
-- time, the same information already inferable from the public leaderboard.
--
-- Pattern: cloud-memory/feedback_supabase_rls_invoker_view_pattern.md

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
         picks,
         total_cost,
         picks_prices_snapshot,
         price_version_at_submission,
         season,
         created_at
    FROM public.fantasy_entries
   WHERE lower(email) = lower(p_email)
     AND season = p_season
   LIMIT 1
$function$;

GRANT EXECUTE ON FUNCTION public.find_fantasy_entry_by_email(text, text) TO anon, authenticated;
