-- Money Scorecard sign-up quality rules, server side (BRO-6339).
--
-- Mirrors src/lib/money-email.ts so a direct API call cannot store a disposable
-- address or a placeholder (a@, test@, asdf@). The mail-server (MX) check
-- stays in the browser: Postgres cannot do DNS. tests/unit/money-gate.test.mjs
-- asserts these lists equal the TypeScript ones.
--
-- Also removes the first junk sign-up, a@a1a.com (owner request 2026-10-26).
--
-- Re-runnable. ROLLBACK: re-apply 20261025_money_scorecard_signups.sql
-- (restores the format-only function body).

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
  v_local TEXT;
  v_domain TEXT;
  v_disposable TEXT[] := ARRAY['10minutemail.com', '10minutemail.net', '20minutemail.com', 'discard.email', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com', 'getairmail.com', 'getnada.com', 'guerrillamail.biz', 'guerrillamail.com', 'guerrillamail.de', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com', 'grr.la', 'harakirimail.com', 'inboxbear.com', 'mail.tm', 'maildrop.cc', 'mailinator.com', 'mailinator.net', 'mailnesia.com', 'mailnull.com', 'mintemail.com', 'moakt.com', 'mohmal.com', 'mytemp.email', 'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.io', 'temp-mail.org', 'tempail.com', 'tempinbox.com', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'throwawaymail.com', 'trashmail.com', 'trashmail.de', 'trashmail.net', 'yopmail.com', 'yopmail.fr', 'yopmail.net', 'zetmail.com'];
  v_junk TEXT[] := ARRAY['abc', 'abc123', 'abcd', 'asd', 'asdf', 'asdfg', 'asdfgh', 'asdfghjkl', 'email', 'example', 'fake', 'foo', 'foobar', 'noemail', 'none', 'noone', 'nobody', 'qwe', 'qwer', 'qwerty', 'qwertyuiop', 'sample', 'test', 'test1', 'test123', 'tester', 'testing', 'testtest', 'xxx', 'xyz', 'zzz', '123', '1234', '12345', '123456'];
BEGIN
  IF length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;
  v_local := split_part(split_part(v_email, '@', 1), '+', 1);
  v_domain := regexp_replace(substring(v_email from '@([^@]*)$'), '\.$', '');
  -- Disposable domain (or a subdomain of one).
  IF EXISTS (SELECT 1 FROM unnest(v_disposable) d WHERE v_domain = d OR v_domain LIKE '%.' || d) THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;
  -- Junk local part: a listed placeholder, or one character repeated 3+ times (a@, aaa@).
  IF v_local = ANY (v_junk) OR v_local ~ '^(.)(\1\1+)?$' THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;
  IF v_role IS NOT NULL AND v_role NOT IN ('producer', 'investor', 'industry', 'press', 'fan') THEN
    v_role := NULL;
  END IF;
  -- Abuse cap: 60 new rows a minute (see 20261025_money_scorecard_signups.sql).
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

DELETE FROM public.money_scorecard_signups WHERE email = 'a@a1a.com';
