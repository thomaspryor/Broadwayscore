-- Money Scorecard email gate (BRO-6210).
--
-- The /biz section and each show page's Money Scorecard section unlock with a
-- one-step email sign-up. Owner decision 2026-10-24/25: this list is its own
-- sub-site, unrelated to the main site list (Formspree -> Resend) and to
-- accounts. So it gets its own table, never read by any sync or broadcast job.
--
-- The browser writes through money_scorecard_signup() only. The table has RLS
-- on and no policies, so anon/authenticated can neither read nor write it
-- directly; the SECURITY DEFINER function validates the input and upserts.
-- One row per email: a repeat sign-up refreshes last_seen_at and keeps the
-- first role/page it was given unless a role arrives where there was none.
--
-- Re-runnable. ROLLBACK:
--   DROP FUNCTION IF EXISTS public.money_scorecard_signup(TEXT, TEXT, TEXT);
--   DROP TABLE IF EXISTS public.money_scorecard_signups;

CREATE TABLE IF NOT EXISTS public.money_scorecard_signups (
  email TEXT PRIMARY KEY,
  role TEXT,
  first_page TEXT,
  signup_count INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.money_scorecard_signups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_scorecard_signups FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_scorecard_signups TO service_role;

CREATE INDEX IF NOT EXISTS money_scorecard_signups_created_at_idx
  ON public.money_scorecard_signups (created_at);

CREATE OR REPLACE FUNCTION public.money_scorecard_signup(p_email TEXT, p_role TEXT, p_page TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT := lower(btrim(coalesce(p_email, '')));
  v_role TEXT := nullif(lower(btrim(coalesce(p_role, ''))), '');
  v_page TEXT := left(nullif(btrim(coalesce(p_page, '')), ''), 200);
BEGIN
  IF length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;
  IF v_role IS NOT NULL AND v_role NOT IN ('producer', 'investor', 'industry', 'press', 'fan') THEN
    v_role := NULL;
  END IF;
  -- Abuse cap: the function is open to anon with no confirmation step, so a
  -- scripted flood of new addresses stops at 60 new rows a minute (dropped
  -- quietly; the browser unlocks the reader either way). Repeat sign-ups of
  -- an existing address are never capped.
  IF NOT EXISTS (SELECT 1 FROM public.money_scorecard_signups WHERE email = v_email)
     AND (SELECT count(*) FROM public.money_scorecard_signups
          WHERE created_at > now() - interval '1 minute') >= 60 THEN
    RETURN TRUE;
  END IF;

  INSERT INTO public.money_scorecard_signups (email, role, first_page)
  VALUES (v_email, v_role, v_page)
  ON CONFLICT (email) DO UPDATE
    SET last_seen_at = now(),
        signup_count = public.money_scorecard_signups.signup_count + 1,
        role = coalesce(public.money_scorecard_signups.role, EXCLUDED.role);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.money_scorecard_signup(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.money_scorecard_signup(TEXT, TEXT, TEXT) TO anon, authenticated;
