-- BRO-7392: let the service role CLEAR a wrongly set reviews_live. Additive-by-replacement and re-runnable.
-- Before: sync_score_call_show only ORed reviews_live in, so a show flagged live by mistake stayed closed forever.
-- After: p_clear_reviews_live => TRUE (service only, off by default) sets reviews_live = p_reviews_live on an
-- open show. A show past closes_at keeps flags-only (OR) behavior: calls are already closed there.
-- The old 7-arg function is dropped first: leaving it would make a call without the new argument ambiguous.

DROP FUNCTION IF EXISTS public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN);

CREATE OR REPLACE FUNCTION public.sync_score_call_show(p_show_id TEXT, p_opening DATE, p_forecast INTEGER, p_lo INTEGER, p_hi INTEGER, p_reviews_live BOOLEAN DEFAULT false, p_enabled BOOLEAN DEFAULT true, p_clear_reviews_live BOOLEAN DEFAULT false)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cur public.score_call_shows%ROWTYPE; closes TIMESTAMPTZ;
BEGIN
  closes := (p_opening::timestamp AT TIME ZONE 'America/New_York');
  SELECT * INTO cur FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND THEN
    IF p_forecast IS NULL THEN RETURN 'skipped_no_forecast'; END IF;
    INSERT INTO public.score_call_shows (show_id, opening_date, closes_at, forecast, lo80, hi80, calls_enabled, reviews_live)
    VALUES (p_show_id, p_opening, closes, p_forecast, p_lo, p_hi, p_enabled, p_reviews_live);
    RETURN 'inserted';
  END IF;
  IF now() >= cur.closes_at THEN
    UPDATE public.score_call_shows SET reviews_live = (cur.reviews_live OR p_reviews_live), calls_enabled = (cur.calls_enabled AND p_enabled), synced_at = now() WHERE show_id = p_show_id;
    RETURN 'closed_flags_only';
  END IF;
  UPDATE public.score_call_shows SET opening_date = p_opening, closes_at = closes,
    forecast = COALESCE(p_forecast, forecast), lo80 = COALESCE(p_lo, lo80), hi80 = COALESCE(p_hi, hi80),
    reviews_live = CASE WHEN p_clear_reviews_live THEN p_reviews_live ELSE (reviews_live OR p_reviews_live) END,
    calls_enabled = (calls_enabled AND p_enabled), synced_at = now()
  WHERE show_id = p_show_id;
  RETURN CASE WHEN p_clear_reviews_live THEN 'updated_cleared' ELSE 'updated' END;
END $$;

REVOKE ALL ON FUNCTION public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, BOOLEAN) TO service_role;

-- Rollback (manual): re-create the 7-arg function from 20261111_score_calls.sql after dropping this one.
