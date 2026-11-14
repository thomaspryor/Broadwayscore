-- BRO-6309: welcome email bookkeeping for Profitability Scorecard sign-ups.
-- welcomed_at marks a row as claimed/sent by scripts/send-money-welcome.js;
-- unsubscribed_at stops it. Everyone who signed up before this ran is marked
-- welcomed ONCE (they were welcomed by hand), so only future sign-ups get the
-- automatic email. Re-runnable: the backfill only happens when the column is created.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.money_scorecard_unsubscribe(TEXT);
--   ALTER TABLE public.money_scorecard_signups DROP COLUMN IF EXISTS welcomed_at, DROP COLUMN IF EXISTS unsubscribed_at;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'money_scorecard_signups' AND column_name = 'welcomed_at') THEN
    ALTER TABLE public.money_scorecard_signups ADD COLUMN welcomed_at TIMESTAMPTZ;
    UPDATE public.money_scorecard_signups SET welcomed_at = now();
  END IF;
END $$;

ALTER TABLE public.money_scorecard_signups ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.money_scorecard_unsubscribe(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH u AS (
    UPDATE public.money_scorecard_signups
       SET unsubscribed_at = coalesce(unsubscribed_at, now())
     WHERE email = lower(btrim(coalesce(p_email, '')))
    RETURNING 1
  )
  SELECT TRUE;
$$;

REVOKE ALL ON FUNCTION public.money_scorecard_unsubscribe(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.money_scorecard_unsubscribe(TEXT) TO anon, authenticated;
