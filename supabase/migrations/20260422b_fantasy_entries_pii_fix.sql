-- P0 REGRESSION FIX (2026-04-22)
-- The earlier same-day migration (20260422_security_advisor_fixes.sql) added a
-- USING (true) SELECT policy on public.fantasy_entries so that the
-- SECURITY INVOKER view could read through. That policy also re-exposed raw
-- email + tiebreakers columns via /rest/v1/fantasy_entries?select=email —
-- undoing the privacy fix from 20260420_fantasy_privacy_index.sql.
--
-- Verified regression via `curl -H "apikey: <anon>" .../rest/v1/fantasy_entries?select=email,tiebreakers`
-- which returned plaintext emails.
--
-- Fix: drop the over-permissive SELECT policy and mediate view reads through
-- a SECURITY DEFINER helper function. Anon can no longer SELECT base table
-- columns directly; the view still returns masked rows through the function.

DROP POLICY IF EXISTS "Anon can read fantasy entries" ON public.fantasy_entries;

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
         picks,
         total_cost,
         picks_prices_snapshot,
         price_version_at_submission,
         season,
         created_at
    FROM public.fantasy_entries
$function$;

GRANT EXECUTE ON FUNCTION public.fantasy_entries_masked() TO anon, authenticated;

DROP VIEW IF EXISTS public.fantasy_entries_public;
CREATE VIEW public.fantasy_entries_public
  WITH (security_invoker = true)
  AS SELECT * FROM public.fantasy_entries_masked();

GRANT SELECT ON public.fantasy_entries_public TO anon, authenticated;
