-- AFTER 20261004_diary_shares.sql: do not re-apply this file on its own. It
-- would recreate plan_shares_guard() and repoint the plans trigger back to
-- it; re-apply 20261004_diary_shares.sql afterwards if you ever must.
-- get_shared_plans(): refuse GET for real (BRO-4481 follow-up).
--
-- 20261001_plan_shares.sql relied on VOLATILE to make PostgREST refuse GET, so
-- the share token would never sit in a URL (and so never in the API's request
-- logs). That assumption was wrong: PostgREST runs a GET RPC inside a
-- READ ONLY transaction and lets ANY function run there, VOLATILE included;
-- only a write fails. get_shared_plans() never writes, so
--   GET /rest/v1/rpc/get_shared_plans?p_token=<token>
-- answered 200 with the payload. scripts/lib/plan-shares-roundtrip.mjs caught it
-- (test-ugc-roundtrip.yml, 2026-10-01).
--
-- Fix: the function checks transaction_read_only itself and raises SQLSTATE
-- 25006 (read_only_sql_transaction), which PostgREST answers with HTTP 405.
-- POST runs read-write and is unaffected. Same body otherwise.
--
-- Tested locally before apply:
--   cat supabase/migrations/20261001_plan_shares.sql supabase/migrations/20261002_plan_shares_refuse_get.sql > /tmp/ps.sql
--   bash scripts/test-plan-shares-sql.sh /tmp/ps.sql tests/sql/plan-shares.test.sql
-- and against the live project by scripts/test-ugc-roundtrip.mjs.
--
-- Re-runnable (CREATE OR REPLACE). ROLLBACK: re-apply 20261001_plan_shares.sql.

CREATE OR REPLACE FUNCTION public.get_shared_plans(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
-- VOLATILE does NOT stop a GET (see header); the read-only check below does.
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_share   public.plan_shares%ROWTYPE;
  v_entries JSONB;
BEGIN
  -- PostgREST GET = read-only transaction. Refuse it so the token only ever
  -- travels in a POST body. Checked before the token so a GET learns nothing.
  IF current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'get_shared_plans must be called with POST'
      USING ERRCODE = '25006';
  END IF;

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
