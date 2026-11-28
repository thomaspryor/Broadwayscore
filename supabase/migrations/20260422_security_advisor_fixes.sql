-- Supabase Security Advisor fixes (2026-04-22)
-- Addresses 2 ERROR + 4 WARN lints from GET /v1/projects/{ref}/advisors/security.
-- Server code uses the anon key (src/lib/supabase-server.ts), so every anon
-- operation the app performs is explicitly whitelisted below. Anything not
-- whitelisted is denied by RLS.

-- ============================================================================
-- ERROR 1: rls_disabled_in_public on public.fantasy_leagues
-- ============================================================================
-- App usage (src/app/api/fantasy/leagues/**): anon SELECT by code, anon INSERT
-- with app-level rate limiting (5 / email / 24h). No UPDATE or DELETE.

ALTER TABLE public.fantasy_leagues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anon can read leagues" ON public.fantasy_leagues;
CREATE POLICY "Anon can read leagues"
  ON public.fantasy_leagues
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Anon can insert leagues" ON public.fantasy_leagues;
CREATE POLICY "Anon can insert leagues"
  ON public.fantasy_leagues
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    created_by ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND char_length(trim(name)) BETWEEN 2 AND 60
    AND char_length(code) = 6
  );

-- ============================================================================
-- ERROR 2: security_definer_view on public.fantasy_entries_public
-- ============================================================================
-- Recreate with SECURITY INVOKER so the view honors the caller's RLS on the
-- underlying fantasy_entries table instead of the view-creator's permissions.
-- Definition taken verbatim from pg_views.

DROP VIEW IF EXISTS public.fantasy_entries_public;
CREATE VIEW public.fantasy_entries_public
  WITH (security_invoker = true)
  AS
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
     FROM public.fantasy_entries;

-- Preserve the anon read access the leaderboard endpoint depends on.
GRANT SELECT ON public.fantasy_entries_public TO anon, authenticated;

-- fantasy_entries must also expose SELECT under the new security_invoker view.
-- Without a SELECT policy, the view returns zero rows for anon callers.
DROP POLICY IF EXISTS "Anon can read fantasy entries" ON public.fantasy_entries;
CREATE POLICY "Anon can read fantasy entries"
  ON public.fantasy_entries
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- ============================================================================
-- WARN: rls_policy_always_true on public.fantasy_entries INSERT
-- ============================================================================
-- User requirement: anyone with a valid email can submit. Enforce the email
-- format + required fields at the database boundary so client bugs or bots
-- can't spray null/garbage rows.

DROP POLICY IF EXISTS "Anyone can insert fantasy entries" ON public.fantasy_entries;
CREATE POLICY "Anon can insert fantasy entries"
  ON public.fantasy_entries
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND picks IS NOT NULL
    AND jsonb_typeof(picks) = 'array'
    AND total_cost >= 0
    AND char_length(season) BETWEEN 4 AND 20
  );

-- ============================================================================
-- WARN: rls_policy_always_true on public.push_tokens INSERT
-- ============================================================================

DROP POLICY IF EXISTS "Anyone can insert push tokens" ON public.push_tokens;
CREATE POLICY "Anon can insert push tokens"
  ON public.push_tokens
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    char_length(token) BETWEEN 8 AND 4096
    AND platform IN ('ios', 'android', 'web')
  );

-- ============================================================================
-- WARN: function_search_path_mutable (4 functions)
-- ============================================================================
-- Lock search_path so mutable role-level search paths can't redirect function
-- calls to an attacker-controlled schema.
--
-- update_updated_at / mask_email — no table references, safe with empty path.
-- handle_new_user — already qualifies public.profiles, safe with empty path.
-- reorder_list_items — body has UNQUALIFIED references to lists / list_items;
--   rewriting with public.* qualifiers first, then locking search_path.

ALTER FUNCTION public.update_updated_at() SET search_path = '';
ALTER FUNCTION public.handle_new_user() SET search_path = '';
ALTER FUNCTION public.mask_email(email_in text) SET search_path = '';

CREATE OR REPLACE FUNCTION public.reorder_list_items(
  p_list_id   uuid,
  p_item_ids  uuid[],
  p_positions integer[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lists
    WHERE id = p_list_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  UPDATE public.list_items
     SET position = data.pos
    FROM unnest(p_item_ids, p_positions) AS data(item_id, pos)
   WHERE public.list_items.id = data.item_id
     AND public.list_items.list_id = p_list_id;
END;
$function$;
