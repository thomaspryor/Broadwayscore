-- AFTER 20261004_diary_shares.sql: do not re-apply this file on its own. It
-- would recreate plan_shares_guard() and repoint the plans trigger back to
-- it; re-apply 20261004_diary_shares.sql afterwards if you ever must.
-- Shared Plans (BRO-4481; spec: docs/specs/shared-plans.md §3.1-3.2).
--
-- One live, login-free link per user showing their upcoming booked shows (date
-- only) and their not-yet-booked watchlist. Two objects:
--
--   plan_shares         owner-only settings row: token, toggles, name shown.
--   get_shared_plans()  the ONLY public read path. SECURITY DEFINER, returns an
--                       explicit field list as JSON, never a row type, so a
--                       column added to watchlist/profiles later cannot leak
--                       through it (the 20260422b_fantasy_entries_pii_fix.sql
--                       lesson). No anon policy exists on any table here.
--
-- Tested locally before apply:
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql tests/sql/plan-shares.test.sql
-- and against the live project by scripts/test-ugc-roundtrip.mjs.
--
-- Re-runnable: apply-migration.yml may be dispatched twice.
--
-- ROLLBACK: revert the app code and confirm it is live FIRST, then land a
-- migration with the DROPs below (a hand-run DROP would leave the schema
-- verifier expecting objects that no longer exist):
--   DROP FUNCTION IF EXISTS public.get_shared_plans(TEXT);
--   DROP FUNCTION IF EXISTS public.rotate_plan_share_token();
--   DROP TABLE IF EXISTS public.plan_shares;   -- drops its trigger too
--   DROP FUNCTION IF EXISTS public.plan_shares_guard();

CREATE TABLE IF NOT EXISTS public.plan_shares (
  user_id        UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- 32 lowercase hex = 122 random bits. Minted ONLY by plan_shares_guard();
  -- the CHECK stops anything weaker getting in by another route.
  token          TEXT NOT NULL UNIQUE
                   DEFAULT replace(gen_random_uuid()::text, '-', '')
                   CHECK (token ~ '^[a-f0-9]{32}$'),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  show_booked    BOOLEAN NOT NULL DEFAULT true,
  show_unbooked  BOOLEAN NOT NULL DEFAULT true,
  -- Copied at creation so the public function never reads profiles. Required:
  -- Apple/email sign-ins often have no profile name, and an unnamed preview
  -- card ("A friend's theater plans") reads as spam.
  display_name   TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 30),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.plan_shares ENABLE ROW LEVEL SECURITY;

-- Owner-only, all four verbs. anon matches none of them (auth.uid() is NULL).
DROP POLICY IF EXISTS "own plan share select" ON public.plan_shares;
DROP POLICY IF EXISTS "own plan share insert" ON public.plan_shares;
DROP POLICY IF EXISTS "own plan share update" ON public.plan_shares;
DROP POLICY IF EXISTS "own plan share delete" ON public.plan_shares;
CREATE POLICY "own plan share select" ON public.plan_shares
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own plan share insert" ON public.plan_shares
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own plan share update" ON public.plan_shares
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own plan share delete" ON public.plan_shares
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Belt and braces: anon has no business touching the table at all, so take
-- away the grant Supabase's default privileges hand it.
REVOKE ALL ON public.plan_shares FROM anon;
-- PostgREST never issues these, so authenticated doesn't need them either.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.plan_shares FROM authenticated;

-- CLIENT CONTRACT (web src/hooks/usePlanShare.ts, iOS hooks/usePlanShare.ts):
--   * Create with an upsert that ALWAYS includes display_name. Postgres checks
--     NOT NULL before resolving ON CONFLICT, so an upsert carrying only the
--     toggles fails even when the row exists.
--   * Change settings with PATCH (`user_id=eq.<uid>`), never an upsert.
--   * Never send `token`; it is ignored. Reset via rotate_plan_share_token().

-- Guard trigger. A client owns its row and could otherwise write any token it
-- likes through the UPDATE policy (e.g. 32 zeros). So:
--   INSERT: always mint a fresh token, whatever the client sent.
--   UPDATE: keep the old token unless rotate_plan_share_token() is the caller
--           (it sets a transaction-local flag); never let user_id move.
CREATE OR REPLACE FUNCTION public.plan_shares_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.token := replace(gen_random_uuid()::text, '-', '');
    NEW.created_at := now();
  ELSE
    IF coalesce(current_setting('bsc.rotate_token', true), '') <> '1' THEN
      NEW.token := OLD.token;
    END IF;
    NEW.user_id := OLD.user_id;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.display_name := btrim(NEW.display_name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.plan_shares_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS plan_shares_guard ON public.plan_shares;
CREATE TRIGGER plan_shares_guard
  BEFORE INSERT OR UPDATE ON public.plan_shares
  FOR EACH ROW EXECUTE FUNCTION public.plan_shares_guard();

-- "Reset link": new token for the caller's own row. SECURITY INVOKER, so the
-- owner-only UPDATE policy still decides which row it can touch. Returns the
-- new token, or NULL when the caller has no share.
CREATE OR REPLACE FUNCTION public.rotate_plan_share_token()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_token TEXT;
BEGIN
  PERFORM set_config('bsc.rotate_token', '1', true);
  UPDATE public.plan_shares
     SET token = replace(gen_random_uuid()::text, '-', '')
   WHERE user_id = auth.uid()
  RETURNING token INTO v_token;
  PERFORM set_config('bsc.rotate_token', '', true);
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_plan_share_token() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_plan_share_token() TO authenticated;

-- Public read path. Returns NULL — identically — for a malformed, unknown,
-- disabled or reset token, or one with both sections switched off, so the
-- response is no oracle for which of those it was.
--
-- What leaves the database (spec §2.2):
--   * name + the two section toggles;
--   * per watchlist row: show_id, planned_date, logged.
--     `logged` is the iOS app's rule (lib/watchlist-slot.ts): a review of that
--     show dated on/after the planned date, or an undated review, means the
--     outing is already in the diary. It is the only fact read from reviews,
--     and only as a boolean.
--   * Rows: undated rows, rows dated from (UTC today - 2) on, and past rows
--     whose outing is logged. The 2-day slack lets the web server decide
--     "today" in the VENUE's timezone; a past, unlogged row older than that
--     (the owner's private "to be rated" list) never leaves.
--   * A section that is switched off is filtered HERE, not just in the UI,
--     with one accepted overlap: with want-to-see off, a logged row inside the
--     2-day slack still leaves (it is indistinguishable from a booked row
--     until the server knows the venue's "today").
--   * The 300-row cap keeps booked candidates first, so a long want-to-see
--     list can never push upcoming bookings off the page.
-- Never selected: curtain_time, time_slot, ids, timestamps, anything from
-- profiles, any review field.
CREATE OR REPLACE FUNCTION public.get_shared_plans(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
-- VOLATILE on purpose: PostgREST only allows GET for STABLE/IMMUTABLE
-- functions, and a GET would put the token in the API's request logs.
-- VOLATILE forces POST, where it travels in the body.
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_share   public.plan_shares%ROWTYPE;
  v_entries JSONB;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{32}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_share
    FROM public.plan_shares
   WHERE token = p_token
     AND enabled
     AND (show_booked OR show_unbooked);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object(
               'show_id', e.show_id,
               'planned_date', e.planned_date,
               'logged', e.logged
             )
             ORDER BY e.created_at DESC
           ),
           '[]'::jsonb)
    INTO v_entries
    FROM (
      SELECT w.show_id, w.planned_date, w.created_at, l.logged
        FROM public.watchlist w
        CROSS JOIN LATERAL (
          SELECT w.planned_date IS NOT NULL AND EXISTS (
                   SELECT 1 FROM public.reviews r
                    WHERE r.user_id = w.user_id
                      AND r.show_id = w.show_id
                      AND (r.date_seen IS NULL OR r.date_seen >= w.planned_date)
                 ) AS logged
        ) l
       WHERE w.user_id = v_share.user_id
         AND (
           -- want-to-see candidates
           (v_share.show_unbooked AND (w.planned_date IS NULL OR (l.logged AND w.planned_date < current_date - 2)))
           -- booked candidates (incl. the timezone slack)
           OR (v_share.show_booked AND w.planned_date >= current_date - 2)
           -- a logged row inside the slack window is want-to-see, not booked
           OR (v_share.show_unbooked AND l.logged AND w.planned_date >= current_date - 2)
         )
       ORDER BY (w.planned_date >= current_date - 2) DESC NULLS LAST, w.created_at DESC
       LIMIT 300
    ) e;

  RETURN jsonb_build_object(
    'name', v_share.display_name,
    'showBooked', v_share.show_booked,
    'showUnbooked', v_share.show_unbooked,
    'entries', v_entries
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_shared_plans(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_plans(TEXT) TO anon, authenticated;

COMMENT ON TABLE public.plan_shares IS
  'Shared Plans link per user (BRO-4481). Public read only via get_shared_plans().';
