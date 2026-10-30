-- iOS alerts: "reviews are in" threshold modes (BRO-6583, from the BRO-6579 quiz).
--
-- The quiz asks "Which shows do you never want to miss?" and offers picks the
-- sender could not honour (reviews_in only knows all / saved / off). A device
-- now also stores a list of modes next to reviews_in:
--
--   critical-gold    the show's critic label is Critical Gold
--   recommended-75   the show's displayed Critic Score is 75 or higher
--   audience-a       the audience grade is A or A+
--   new-musical      a new Broadway (or West End) musical
--
-- A show qualifies when it matches ANY listed mode. reviews_in is untouched:
-- 'all' still means every new show in the device's market, 'saved' still means
-- To Watch only (the modes add to it), 'off' still means nothing and wins over
-- the modes. A separate column (not new reviews_in values) keeps builds that
-- predate this working: their CHECK, RPC call and parser never see a new value.
--
-- set_push_prefs gains p_reviews_in_modes. The 7-argument function is dropped
-- first: leaving both would make an old build's 7-named-argument call match
-- two candidates and fail as ambiguous. The new function has every old argument
-- in the same order with the new one last, defaulting to NULL (keep stored
-- value), so old calls keep working unchanged. NULL keeps, an empty array
-- clears.
--
-- Re-runnable. ROLLBACK (sender and app reverted first):
--   DROP FUNCTION IF EXISTS public.set_push_prefs(text, text, boolean, boolean, boolean, text, boolean, text[]);
--   ALTER TABLE public.push_tokens DROP COLUMN IF EXISTS reviews_in_modes;
--   then re-run the set_push_prefs block of 20261026_push_alert_prefs.sql.

ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS reviews_in_modes TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_reviews_in_modes_check;
ALTER TABLE public.push_tokens ADD CONSTRAINT push_tokens_reviews_in_modes_check
  CHECK (reviews_in_modes <@ ARRAY['critical-gold', 'recommended-75', 'audience-a', 'new-musical']::text[]);

DROP FUNCTION IF EXISTS public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN);

CREATE OR REPLACE FUNCTION public.set_push_prefs(
  p_token TEXT,
  p_reviews_in TEXT DEFAULT NULL,
  p_closing_week BOOLEAN DEFAULT NULL,
  p_closing_posted BOOLEAN DEFAULT NULL,
  p_rate BOOLEAN DEFAULT NULL,
  p_market TEXT DEFAULT NULL,
  p_local_reminders BOOLEAN DEFAULT NULL,
  p_reviews_in_modes TEXT[] DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_token IS NULL OR char_length(p_token) < 8 OR char_length(p_token) > 4096 THEN
    RAISE EXCEPTION 'invalid push token' USING ERRCODE = '22023';
  END IF;
  IF p_reviews_in IS NOT NULL AND p_reviews_in NOT IN ('all', 'saved', 'off') THEN
    RAISE EXCEPTION 'invalid reviews_in' USING ERRCODE = '22023';
  END IF;
  IF p_market IS NOT NULL AND p_market NOT IN ('nyc', 'london') THEN
    RAISE EXCEPTION 'invalid market' USING ERRCODE = '22023';
  END IF;
  -- <@ is false for an array with a NULL element, so those are rejected too.
  IF p_reviews_in_modes IS NOT NULL AND NOT (
    p_reviews_in_modes <@ ARRAY['critical-gold', 'recommended-75', 'audience-a', 'new-musical']::text[]
  ) THEN
    RAISE EXCEPTION 'invalid reviews_in_modes' USING ERRCODE = '22023';
  END IF;

  UPDATE public.push_tokens
     SET reviews_in = COALESCE(p_reviews_in, reviews_in),
         -- ARRAY(subquery) over a NULL input is '{}', not NULL: branch explicitly so NULL keeps.
         reviews_in_modes = CASE
           WHEN p_reviews_in_modes IS NULL THEN reviews_in_modes
           ELSE ARRAY(SELECT DISTINCT m FROM unnest(p_reviews_in_modes) AS m ORDER BY m)
         END,
         closing_week = COALESCE(p_closing_week, closing_week),
         closing_posted = COALESCE(p_closing_posted, closing_posted),
         rate = COALESCE(p_rate, rate),
         market = COALESCE(p_market, market),
         local_reminders = COALESCE(p_local_reminders, local_reminders),
         prefs_updated_at = now()
   WHERE token = p_token;
END;
$$;

REVOKE ALL ON FUNCTION public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN, TEXT[])
  TO anon, authenticated, service_role;
