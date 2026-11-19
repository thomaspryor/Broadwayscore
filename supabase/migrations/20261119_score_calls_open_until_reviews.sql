-- BRO-7857 Predict the Score: keep predictions open until the first review is live on the site (owner 2026-11-19).
-- Before: closes_at = 00:00 New York on opening day. After: reviews_live is the close; closes_at is a backstop at
-- 00:00 New York two days after opening (opening day + CALL_GRACE_DAYS = 1 in src/lib/score-call.js; a unit test pins them).
-- reviews_live is flipped by scripts/close-score-calls-on-reviews.mjs from vercel-deploy.yml (before each prod build)
-- and rebuild-fast.yml (before live score payloads publish), so the server closes as the first review goes out.
-- Re-runnable. Rollback at the bottom (commented).
BEGIN;

-- Same signature and columns as 20261113. Only change: a show whose reviews are live answers calls_closed (it is closed, not "not open yet").
CREATE OR REPLACE FUNCTION public.lock_score_call(p_show_id TEXT, p_score INTEGER)
RETURNS TABLE (called_score SMALLINT, forecast SMALLINT, lo80 SMALLINT, hi80 SMALLINT, locked_at TIMESTAMPTZ, closes_at TIMESTAMPTZ, lo50 SMALLINT, hi50 SMALLINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.score_call_shows%ROWTYPE; uid UUID := auth.uid(); rec public.score_calls%ROWTYPE;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN RAISE EXCEPTION 'bad_score'; END IF;
  SELECT * INTO s FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND OR NOT s.calls_enabled THEN RAISE EXCEPTION 'not_open'; END IF;
  IF s.reviews_live OR now() >= s.closes_at THEN RAISE EXCEPTION 'calls_closed'; END IF;
  BEGIN
    INSERT INTO public.score_calls AS c (user_id, show_id, called_score, forecast_at_lock, lo80_at_lock, hi80_at_lock, lo50_at_lock, hi50_at_lock)
    VALUES (uid, p_show_id, p_score, s.forecast, s.lo80, s.hi80, s.lo50, s.hi50) RETURNING c.* INTO rec;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'already_called';
  END;
  RETURN QUERY SELECT rec.called_score, rec.forecast_at_lock, rec.lo80_at_lock, rec.hi80_at_lock, rec.locked_at, s.closes_at, rec.lo50_at_lock, rec.hi50_at_lock;
END $$;

-- Same as 20261113 except the backstop: closes_at = 00:00 New York on opening + 2 days.
CREATE OR REPLACE FUNCTION public.sync_score_call_show(p_show_id TEXT, p_opening DATE, p_forecast INTEGER, p_lo INTEGER, p_hi INTEGER, p_reviews_live BOOLEAN DEFAULT false, p_enabled BOOLEAN DEFAULT true, p_lo50 INTEGER DEFAULT NULL, p_hi50 INTEGER DEFAULT NULL)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cur public.score_call_shows%ROWTYPE; closes TIMESTAMPTZ; ef INTEGER; elo INTEGER; ehi INTEGER; d RECORD; n_lo INTEGER; n_hi INTEGER;
BEGIN
  closes := ((p_opening + 2)::timestamp AT TIME ZONE 'America/New_York');
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

-- Service-only: close one show because a review is going live. One-way; clear_score_call_reviews_live undoes a false positive before the backstop.
CREATE OR REPLACE FUNCTION public.mark_score_call_reviews_live(p_show_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cur public.score_call_shows%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF cur.reviews_live THEN RETURN 'unchanged'; END IF;
  UPDATE public.score_call_shows SET reviews_live = true, synced_at = now() WHERE show_id = p_show_id;
  RETURN 'marked';
END $$;
REVOKE ALL ON FUNCTION public.mark_score_call_reviews_live(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_score_call_reviews_live(TEXT) TO service_role;
-- CREATE OR REPLACE keeps existing grants; restate them so a fresh database matches.
REVOKE ALL ON FUNCTION public.lock_score_call(TEXT, INTEGER), public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_score_call(TEXT, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, INTEGER, INTEGER) TO service_role;

-- Move the backstop only for shows opening today (New York) or later with no review live. A show that opened
-- yesterday or earlier stays closed: this database cannot see whether its reviews are already out.
UPDATE public.score_call_shows
  SET closes_at = ((opening_date + 2)::timestamp AT TIME ZONE 'America/New_York')
  WHERE opening_date >= (now() AT TIME ZONE 'America/New_York')::date AND NOT reviews_live;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- Rollback (manual): recreate lock_score_call and sync_score_call_show from 20261113_score_calls_range50_readers.sql,
--   DROP FUNCTION public.mark_score_call_reviews_live(TEXT);
--   UPDATE public.score_call_shows SET closes_at = (opening_date::timestamp AT TIME ZONE 'America/New_York') WHERE closes_at > now();
