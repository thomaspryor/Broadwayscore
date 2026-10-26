-- Money Scorecard gate: refuse fake addresses server-side (BRO-6339).
--
-- Mirrors the disposable-domain and junk-local-part rules of
-- src/lib/money-email.ts so a direct API call cannot store them. The mail-
-- server (MX) check is browser-only: a database function cannot do DNS.
-- Also removes the one junk sign-up that predates the rules.
--
-- Re-runnable. ROLLBACK: re-apply 20261025_money_scorecard_signups.sql.

DELETE FROM public.money_scorecard_signups WHERE email = 'a@a1a.com';

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
BEGIN
  IF length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023';
  END IF;
  -- Same disposable-domain and junk-local rules as src/lib/money-email.ts.
  v_local := left(v_email, length(v_email) - length(split_part(v_email, '@', 2)) - 1);
  v_domain := split_part(v_email, '@', 2);
  IF length(v_local) < 2
     OR v_local ~ '^(.)\1+$'
     OR v_local = ANY (ARRAY['test','tester','testing','test1','test123','asdf','asdfg','asdfgh','asdfghjkl','qwerty','qwe','abc','abcd','abc123','xxx','xyz','none','noemail','no','nobody','fake','fakeemail','email','user','name','me','foo','bar','foobar','sample','spam','junk','temp','null'])
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org','guerrillamail.biz','guerrillamail.de','guerrillamailblock.com','sharklasers.com','grr.la','spam4.me','pokemail.net','10minutemail.com','10minutemail.net','20minutemail.com','tempmail.com','temp-mail.org','temp-mail.io','tempmail.net','tempail.com','tempr.email','throwawaymail.com','trashmail.com','trashmail.net','trashmail.me','yopmail.com','yopmail.net','yopmail.fr','getnada.com','nada.email','dispostable.com','maildrop.cc','mailnesia.com','mailcatch.com','mintemail.com','mohmal.com','fakeinbox.com','fakemail.net','emailondeck.com','moakt.com','burnermail.io','mytemp.email','inboxkitten.com','mail.tm','mailsac.com','spamgourmet.com','discard.email','discardmail.com','harakirimail.com','jetable.org','getairmail.com','anonbox.net','mailforspam.com','tmail.ws','tmpmail.org','tmpmail.net','emailfake.com','fakemailgenerator.com','mailtemp.info','luxusmail.org','byom.de','owlymail.com','mvrht.net','cuvox.de','dayrep.com','einrot.com','fleckens.hu','gustr.com','jourrapide.com','rhyta.com','superrito.com','teleworm.us','armyspy.com']) d
                WHERE v_domain = d OR v_domain LIKE '%.' || d) THEN
    RAISE EXCEPTION 'invalid email: refused' USING ERRCODE = '22023';
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
