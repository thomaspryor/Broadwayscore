-- BRO-7430 Predict the Score: a narrower "likely range" (50% band) and the readers' average.
-- Additive columns, then the three RPCs recreated with the same argument and column names plus new ones.
-- Rollback at the bottom (commented). The applied 20261111 migration is untouched.
BEGIN;

ALTER TABLE public.score_call_shows ADD COLUMN IF NOT EXISTS lo50 SMALLINT CHECK (lo50 BETWEEN 0 AND 100);
ALTER TABLE public.score_call_shows ADD COLUMN IF NOT EXISTS hi50 SMALLINT CHECK (hi50 BETWEEN 0 AND 100);
ALTER TABLE public.score_calls ADD COLUMN IF NOT EXISTS lo50_at_lock SMALLINT;
ALTER TABLE public.score_calls ADD COLUMN IF NOT EXISTS hi50_at_lock SMALLINT;

-- The ONE place a 50% band is derived from an 80% band: each side is 0.53 of its 80% half-width
-- (normal 25/75 over 10/90 quantile ratio, 0.674/1.282). A side the model clamped at 0 or 100 borrows the
-- other side's half-width, so a forecast near the ceiling does not get a falsely narrow band.
-- Used for old rows and for any sync that sends no true value. Internal: no client role can run it.
CREATE OR REPLACE FUNCTION public.score_call_range50(f INTEGER, lo80 INTEGER, hi80 INTEGER)
RETURNS TABLE (lo50 SMALLINT, hi50 SMALLINT)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT
    CASE WHEN f IS NULL OR lo80 IS NULL OR hi80 IS NULL THEN NULL
      ELSE greatest(0, least(f, round(f - 0.53 * (CASE WHEN lo80 <= 0 AND hi80 < 100 THEN hi80 - f ELSE f - lo80 END))))::SMALLINT END,
    CASE WHEN f IS NULL OR lo80 IS NULL OR hi80 IS NULL THEN NULL
      ELSE least(100, greatest(f, round(f + 0.53 * (CASE WHEN hi80 >= 100 AND lo80 > 0 THEN f - lo80 ELSE hi80 - f END))))::SMALLINT END
$$;
REVOKE ALL ON FUNCTION public.score_call_range50(INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.score_call_range50(INTEGER, INTEGER, INTEGER) TO service_role;

-- Backfill: every forecast row and every locked snapshot gets a range, derived from its own 80% band.
UPDATE public.score_call_shows s SET lo50 = d.lo50, hi50 = d.hi50
  FROM LATERAL public.score_call_range50(s.forecast, s.lo80, s.hi80) d WHERE s.lo50 IS NULL AND s.forecast IS NOT NULL;
UPDATE public.score_calls c SET lo50_at_lock = d.lo50, hi50_at_lock = d.hi50
  FROM LATERAL public.score_call_range50(c.forecast_at_lock, c.lo80_at_lock, c.hi80_at_lock) d WHERE c.lo50_at_lock IS NULL AND c.forecast_at_lock IS NOT NULL;

-- The likely range always sits inside the 80% range.
ALTER TABLE public.score_call_shows DROP CONSTRAINT IF EXISTS score_call_shows_range50_inside80;
ALTER TABLE public.score_call_shows ADD CONSTRAINT score_call_shows_range50_inside80
  CHECK (lo50 <= hi50 AND (lo80 IS NULL OR lo50 >= lo80) AND (hi80 IS NULL OR hi50 <= hi80));

DROP FUNCTION IF EXISTS public.lock_score_call(TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.get_my_score_calls();
DROP FUNCTION IF EXISTS public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN);

CREATE FUNCTION public.lock_score_call(p_show_id TEXT, p_score INTEGER)
RETURNS TABLE (called_score SMALLINT, forecast SMALLINT, lo80 SMALLINT, hi80 SMALLINT, locked_at TIMESTAMPTZ, closes_at TIMESTAMPTZ, lo50 SMALLINT, hi50 SMALLINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.score_call_shows%ROWTYPE; uid UUID := auth.uid(); rec public.score_calls%ROWTYPE;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN RAISE EXCEPTION 'bad_score'; END IF;
  SELECT * INTO s FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND OR NOT s.calls_enabled OR s.reviews_live THEN RAISE EXCEPTION 'not_open'; END IF;
  IF now() >= s.closes_at THEN RAISE EXCEPTION 'calls_closed'; END IF;
  BEGIN
    INSERT INTO public.score_calls AS c (user_id, show_id, called_score, forecast_at_lock, lo80_at_lock, hi80_at_lock, lo50_at_lock, hi50_at_lock)
    VALUES (uid, p_show_id, p_score, s.forecast, s.lo80, s.hi80, s.lo50, s.hi50) RETURNING c.* INTO rec;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'already_called';
  END;
  RETURN QUERY SELECT rec.called_score, rec.forecast_at_lock, rec.lo80_at_lock, rec.hi80_at_lock, rec.locked_at, s.closes_at, rec.lo50_at_lock, rec.hi50_at_lock;
END $$;

CREATE FUNCTION public.get_my_score_calls()
RETURNS TABLE (show_id TEXT, called_score SMALLINT, forecast SMALLINT, lo80 SMALLINT, hi80 SMALLINT, locked_at TIMESTAMPTZ, lo50 SMALLINT, hi50 SMALLINT)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT c.show_id, c.called_score, c.forecast_at_lock, c.lo80_at_lock, c.hi80_at_lock, c.locked_at, c.lo50_at_lock, c.hi50_at_lock
  FROM public.score_calls c WHERE c.user_id = auth.uid() ORDER BY c.locked_at DESC
$$;

-- Other readers' average for the shows THIS caller has locked, never one row per reader. Rows come back only
-- for shows where the caller has a locked call and at least one other reader exists; the caller is excluded.
-- Anon has no auth.uid() and no EXECUTE. With exactly one other reader the average is that reader's number
-- (owner decision 2026-11-13: show from n=1).
CREATE FUNCTION public.get_score_call_readers()
RETURNS TABLE (show_id TEXT, readers_avg INTEGER, readers_n INTEGER)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT o.show_id, round(avg(o.called_score))::INTEGER, count(*)::INTEGER
  FROM public.score_calls me
  JOIN public.score_calls o ON o.show_id = me.show_id AND o.user_id <> me.user_id
  WHERE me.user_id = auth.uid()
  GROUP BY o.show_id
$$;

-- p_lo50/p_hi50 are optional so a loader that predates them keeps working; without them the range is derived.
CREATE FUNCTION public.sync_score_call_show(p_show_id TEXT, p_opening DATE, p_forecast INTEGER, p_lo INTEGER, p_hi INTEGER, p_reviews_live BOOLEAN DEFAULT false, p_enabled BOOLEAN DEFAULT true, p_lo50 INTEGER DEFAULT NULL, p_hi50 INTEGER DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cur public.score_call_shows%ROWTYPE; closes TIMESTAMPTZ; ef INTEGER; elo INTEGER; ehi INTEGER; d RECORD; n_lo INTEGER; n_hi INTEGER;
BEGIN
  closes := (p_opening::timestamp AT TIME ZONE 'America/New_York');
  SELECT * INTO cur FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND THEN
    IF p_forecast IS NULL THEN RETURN 'skipped_no_forecast'; END IF;
    SELECT * INTO d FROM public.score_call_range50(p_forecast, p_lo, p_hi);
    INSERT INTO public.score_call_shows (show_id, opening_date, closes_at, forecast, lo80, hi80, lo50, hi50, calls_enabled, reviews_live)
    VALUES (p_show_id, p_opening, closes, p_forecast, p_lo, p_hi, COALESCE(p_lo50, d.lo50), COALESCE(p_hi50, d.hi50), p_enabled, p_reviews_live);
    RETURN 'inserted';
  END IF;
  IF now() >= cur.closes_at THEN
    UPDATE public.score_call_shows SET reviews_live = (cur.reviews_live OR p_reviews_live), calls_enabled = (cur.calls_enabled AND p_enabled), synced_at = now() WHERE show_id = p_show_id;
    RETURN 'closed_flags_only';
  END IF;
  ef := COALESCE(p_forecast, cur.forecast); elo := COALESCE(p_lo, cur.lo80); ehi := COALESCE(p_hi, cur.hi80);
  SELECT * INTO d FROM public.score_call_range50(ef, elo, ehi);
  n_lo := COALESCE(p_lo50, d.lo50); n_hi := COALESCE(p_hi50, d.hi50);
  UPDATE public.score_call_shows SET opening_date = p_opening, closes_at = closes,
    forecast = ef, lo80 = elo, hi80 = ehi, lo50 = n_lo, hi50 = n_hi,
    reviews_live = (reviews_live OR p_reviews_live), calls_enabled = (calls_enabled AND p_enabled), synced_at = now()
  WHERE show_id = p_show_id;
  RETURN 'updated';
END $$;

REVOKE ALL ON FUNCTION public.lock_score_call(TEXT, INTEGER), public.get_my_score_calls(), public.get_score_call_readers(),
  public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_score_call(TEXT, INTEGER), public.get_my_score_calls(), public.get_score_call_readers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, INTEGER, INTEGER) TO service_role;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Rollback (manual): restore the three functions from 20261111_score_calls.sql, then
--   DROP FUNCTION public.get_score_call_readers(), public.score_call_range50(INTEGER, INTEGER, INTEGER);
--   ALTER TABLE public.score_call_shows DROP COLUMN lo50, DROP COLUMN hi50; ALTER TABLE public.score_calls DROP COLUMN lo50_at_lock, DROP COLUMN hi50_at_lock;
