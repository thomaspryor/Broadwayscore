-- get_shared_plans(): include the owner's curtain time on booked rows.
--
-- Owner decision 2026-11-01 reverses BRO-4481's "friends only ever see the
-- date": a friend's "Add to Calendar" from a Shared Plans link made an all-day
-- event, which a user complained about. A booked row (planned_date set) now
-- also carries `curtain_time` ("HH:MM:SS" local wall-clock, or null when the
-- owner never picked a showtime). The web view builds a timed event from it
-- (runtime + buffer) and falls back to all-day when it is null.
--
-- Still never selected: time_slot, ids, timestamps, profiles, review fields.
-- An undated (want-to-see) row never carries a time.
--
-- Same body as 20261002_plan_shares_refuse_get.sql otherwise (GET refusal
-- kept). CREATE OR REPLACE drops function-level SET options, so the
-- `timezone = 'UTC'` pin from 20261004_diary_shares.sql is re-applied below.
--
-- Tested locally before apply:
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql \
--     supabase/migrations/20261002_plan_shares_refuse_get.sql \
--     supabase/migrations/20261004_diary_shares.sql \
--     supabase/migrations/20261101_plan_shares_curtain_time.sql tests/sql/plan-shares.test.sql
--
-- Re-runnable (CREATE OR REPLACE). ROLLBACK: re-apply
-- 20261002_plan_shares_refuse_get.sql, then the ALTER ... SET timezone line
-- from 20261004_diary_shares.sql (the web side treats a missing key as null).

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
               'curtain_time', CASE WHEN e.planned_date IS NULL THEN NULL ELSE to_char(e.curtain_time, 'HH24:MI:SS') END,
               'logged', e.logged
             )
             ORDER BY e.created_at DESC
           ),
           '[]'::jsonb)
    INTO v_entries
    FROM (
      SELECT w.show_id, w.planned_date, w.curtain_time, w.created_at, l.logged
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

ALTER FUNCTION public.get_shared_plans(TEXT) SET timezone = 'UTC';
