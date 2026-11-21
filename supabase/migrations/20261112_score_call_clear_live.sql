-- BRO-7392: reviews_live was one-way (OR). A false positive (a stray review row) closed a show for good.
-- Service-only clear, valid before close. Rollback: DROP FUNCTION public.clear_score_call_reviews_live(TEXT);
CREATE OR REPLACE FUNCTION public.clear_score_call_reviews_live(p_show_id TEXT)
RETURNS TEXT LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cur public.score_call_shows%ROWTYPE;
BEGIN
  SELECT * INTO cur FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF now() >= cur.closes_at THEN RETURN 'closed'; END IF;
  IF NOT cur.reviews_live THEN RETURN 'unchanged'; END IF;
  UPDATE public.score_call_shows SET reviews_live = false, synced_at = now() WHERE show_id = p_show_id;
  RETURN 'cleared';
END $$;
REVOKE ALL ON FUNCTION public.clear_score_call_reviews_live(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_score_call_reviews_live(TEXT) TO service_role;
