-- BRO-7350 Call the Score. Additive and re-runnable. Rollback at the bottom (commented).
-- score_call_shows: one row per open show; holds the PRIVATE forecast. No client role can read it.
-- score_calls: one locked call per (user, show). Forecast is only revealed by lock_score_call / get_my_score_calls.

CREATE TABLE IF NOT EXISTS public.score_call_shows (
  show_id        TEXT PRIMARY KEY,
  opening_date   DATE NOT NULL,
  closes_at      TIMESTAMPTZ NOT NULL,
  forecast       SMALLINT CHECK (forecast BETWEEN 0 AND 100),
  lo80           SMALLINT CHECK (lo80 BETWEEN 0 AND 100),
  hi80           SMALLINT CHECK (hi80 BETWEEN 0 AND 100),
  calls_enabled  BOOLEAN NOT NULL DEFAULT true,
  reviews_live   BOOLEAN NOT NULL DEFAULT false,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.score_calls (
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  show_id           TEXT NOT NULL REFERENCES public.score_call_shows(show_id),
  called_score      SMALLINT NOT NULL CHECK (called_score BETWEEN 0 AND 100),
  forecast_at_lock  SMALLINT,
  lo80_at_lock      SMALLINT,
  hi80_at_lock      SMALLINT,
  locked_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, show_id)
);

ALTER TABLE public.score_call_shows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.score_calls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.score_call_shows FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.score_calls FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "own calls" ON public.score_calls;
CREATE POLICY "own calls" ON public.score_calls FOR SELECT TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.score_calls TO authenticated;
GRANT ALL ON public.score_call_shows, public.score_calls TO service_role;

-- Lock a call. Final: a second lock raises already_called. Reveals the forecast snapshot.
CREATE OR REPLACE FUNCTION public.lock_score_call(p_show_id TEXT, p_score INTEGER)
RETURNS TABLE (called_score SMALLINT, forecast SMALLINT, lo80 SMALLINT, hi80 SMALLINT, locked_at TIMESTAMPTZ, closes_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.score_call_shows%ROWTYPE; uid UUID := auth.uid(); rec public.score_calls%ROWTYPE;
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN RAISE EXCEPTION 'bad_score'; END IF;
  SELECT * INTO s FROM public.score_call_shows WHERE show_id = p_show_id;
  IF NOT FOUND OR NOT s.calls_enabled OR s.reviews_live THEN RAISE EXCEPTION 'not_open'; END IF;
  IF now() >= s.closes_at THEN RAISE EXCEPTION 'calls_closed'; END IF;
  BEGIN
    INSERT INTO public.score_calls AS c (user_id, show_id, called_score, forecast_at_lock, lo80_at_lock, hi80_at_lock)
    VALUES (uid, p_show_id, p_score, s.forecast, s.lo80, s.hi80) RETURNING c.* INTO rec;
  EXCEPTION WHEN unique_violation THEN RAISE EXCEPTION 'already_called';
  END;
  RETURN QUERY SELECT rec.called_score, rec.forecast_at_lock, rec.lo80_at_lock, rec.hi80_at_lock, rec.locked_at, s.closes_at;
END $$;

-- The caller's own calls, with the snapshot taken when they locked.
CREATE OR REPLACE FUNCTION public.get_my_score_calls()
RETURNS TABLE (show_id TEXT, called_score SMALLINT, forecast SMALLINT, lo80 SMALLINT, hi80 SMALLINT, locked_at TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT c.show_id, c.called_score, c.forecast_at_lock, c.lo80_at_lock, c.hi80_at_lock, c.locked_at
  FROM public.score_calls c WHERE c.user_id = auth.uid() ORDER BY c.locked_at DESC
$$;

-- Service-only: upsert one show from the pilot ledger. Never nulls a forecast, never edits after close.
CREATE OR REPLACE FUNCTION public.sync_score_call_show(p_show_id TEXT, p_opening DATE, p_forecast INTEGER, p_lo INTEGER, p_hi INTEGER, p_reviews_live BOOLEAN DEFAULT false, p_enabled BOOLEAN DEFAULT true)
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
    reviews_live = (reviews_live OR p_reviews_live), calls_enabled = (calls_enabled AND p_enabled), synced_at = now()
  WHERE show_id = p_show_id;
  RETURN 'updated';
END $$;

-- Service-only: per-show count and mean of locked calls, no user ids (daily export to the pilot ledger).
CREATE OR REPLACE FUNCTION public.score_call_export()
RETURNS TABLE (show_id TEXT, calls BIGINT, mean_call NUMERIC)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = '' AS $$
  SELECT c.show_id, count(*), round(avg(c.called_score)::numeric, 1) FROM public.score_calls c GROUP BY c.show_id
$$;

REVOKE ALL ON FUNCTION public.lock_score_call(TEXT, INTEGER), public.get_my_score_calls(),
  public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN), public.score_call_export()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_score_call(TEXT, INTEGER), public.get_my_score_calls() TO authenticated;
GRANT EXECUTE ON FUNCTION public.sync_score_call_show(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN), public.score_call_export() TO service_role;

-- Rollback (manual): DROP FUNCTION public.lock_score_call(TEXT,INTEGER), public.get_my_score_calls(),
--   public.sync_score_call_show(TEXT,DATE,INTEGER,INTEGER,INTEGER,BOOLEAN,BOOLEAN), public.score_call_export();
--   DROP TABLE public.score_calls; DROP TABLE public.score_call_shows;
