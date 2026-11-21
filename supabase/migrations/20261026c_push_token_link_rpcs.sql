-- iOS push tokens: make re-registration and sign-out actually write (BRO-6366).
--
-- push_tokens grants clients no SELECT (tokens are device secrets). PostgreSQL
-- applies SELECT visibility to the rows an UPDATE's WHERE reads, so the app's
-- `UPDATE push_tokens ... WHERE token = x` matched zero rows and still returned
-- 204. Measured 2026-10-26: 412 rows, 0 with user_id NULL (sign-out unlink never
-- worked), and updated_at only ever set by the first insert, so the sender's
-- 90-day window would drop the earliest phones from about 2026-11-10.
--
-- Same capability model as set_push_prefs (20261026_push_alert_prefs.sql):
-- knowing the token is the right to change that row, which is what
-- push_tokens_claim_update (using (true)) was always meant to grant. In
-- practice that policy never matched a row (see above), so these functions DO
-- make the capability real: a holder of someone's Expo token can now unlink
-- it, or link it to their own account. The token never leaves the phone or the
-- service role, so that exposure is accepted; what neither function can ever
-- do is name another user:
--   link_push_token(p_token)    signed in: user_id := auth.uid().
--                               signed out: user_id unchanged (freshness only).
--                               updated_at := now() either way.
--   unlink_push_token(p_token)  user_id := NULL, updated_at := now().
-- link never clears an owner. A launch whose session refresh failed (offline,
-- 5xx) calls it with the anon key; if that unlinked, a signed-in user would
-- lose personal alerts until a cold start. Only an explicit sign-out unlinks.
-- Both: SECURITY DEFINER, search_path '', validate the token, UPDATE only (never
-- create a row), RETURN VOID so they are not a token-existence oracle, REVOKE
-- from PUBLIC then GRANT to anon + authenticated explicitly.
--
-- set_push_prefs also bumps updated_at now, so a device on the new build stays
-- fresh on every launch even when the link write is skipped.
--
-- Must be live in prod BEFORE the app change ships (the app's security tests
-- call these against prod). Re-runnable. ROLLBACK: the app treats a missing
-- RPC as a logged error and still calls set_push_prefs, so dropping these is
-- safe for shipped builds (they fall back to the old never-relinking state):
--   DROP FUNCTION IF EXISTS public.link_push_token(text);
--   DROP FUNCTION IF EXISTS public.unlink_push_token(text);
--   and re-run the set_push_prefs definition from 20261026_push_alert_prefs.sql.

CREATE OR REPLACE FUNCTION public.link_push_token(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_token IS NULL OR char_length(p_token) < 8 OR char_length(p_token) > 4096 THEN
    RAISE EXCEPTION 'invalid push token' USING ERRCODE = '22023';
  END IF;

  UPDATE public.push_tokens
     SET user_id = COALESCE((SELECT auth.uid()), user_id),
         updated_at = now()
   WHERE token = p_token;
END;
$$;

REVOKE ALL ON FUNCTION public.link_push_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_push_token(TEXT) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unlink_push_token(p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_token IS NULL OR char_length(p_token) < 8 OR char_length(p_token) > 4096 THEN
    RAISE EXCEPTION 'invalid push token' USING ERRCODE = '22023';
  END IF;

  UPDATE public.push_tokens
     SET user_id = NULL,
         updated_at = now()
   WHERE token = p_token;
END;
$$;

REVOKE ALL ON FUNCTION public.unlink_push_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlink_push_token(TEXT) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_push_prefs(
  p_token TEXT,
  p_reviews_in TEXT DEFAULT NULL,
  p_closing_week BOOLEAN DEFAULT NULL,
  p_closing_posted BOOLEAN DEFAULT NULL,
  p_rate BOOLEAN DEFAULT NULL,
  p_market TEXT DEFAULT NULL,
  p_local_reminders BOOLEAN DEFAULT NULL
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

  UPDATE public.push_tokens
     SET reviews_in = COALESCE(p_reviews_in, reviews_in),
         closing_week = COALESCE(p_closing_week, closing_week),
         closing_posted = COALESCE(p_closing_posted, closing_posted),
         rate = COALESCE(p_rate, rate),
         market = COALESCE(p_market, market),
         local_reminders = COALESCE(p_local_reminders, local_reminders),
         prefs_updated_at = now(),
         updated_at = now()
   WHERE token = p_token;
END;
$$;

REVOKE ALL ON FUNCTION public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN)
  TO anon, authenticated, service_role;
