-- BRO-7704: start the welcome run the moment a Profitability Scorecard sign-up is stored.
-- AFTER INSERT trigger -> pg_net async POST to /api/money-welcome-kick (shared secret) -> workflow_dispatch
-- money-welcome.yml. pg_net is fire-and-forget: a failure never rolls back or slows the insert, and the
-- hourly cron plus the welcomed_at claim remain the backstop. The URL and secret live in a private table
-- (RLS on, no policies, no grants), readable only by the SECURITY DEFINER trigger function.
--
-- AFTER APPLYING (one time, service role / SQL editor; the secret must equal Vercel MONEY_WELCOME_KICK_SECRET):
--   INSERT INTO public.money_welcome_kick_config (id, url, secret)
--   VALUES (true, 'https://broadwayscorecard.com/api/money-welcome-kick', '<secret>')
--   ON CONFLICT (id) DO UPDATE SET url = excluded.url, secret = excluded.secret;
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS money_scorecard_signups_kick ON public.money_scorecard_signups;
--   DROP FUNCTION IF EXISTS public.money_welcome_kick();
--   DROP TABLE IF EXISTS public.money_welcome_kick_config;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.money_welcome_kick_config (
  id     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  url    TEXT NOT NULL,
  secret TEXT NOT NULL
);
ALTER TABLE public.money_welcome_kick_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.money_welcome_kick_config FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.money_welcome_kick()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  cfg public.money_welcome_kick_config%ROWTYPE;
BEGIN
  BEGIN
    SELECT * INTO cfg FROM public.money_welcome_kick_config WHERE id;
    IF FOUND THEN
      PERFORM net.http_post(
        url := cfg.url,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-kick-secret', cfg.secret),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Never block a sign-up on the kick; the hourly cron picks the row up.
    RAISE WARNING 'money_welcome_kick failed: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.money_welcome_kick() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS money_scorecard_signups_kick ON public.money_scorecard_signups;
CREATE TRIGGER money_scorecard_signups_kick
  AFTER INSERT ON public.money_scorecard_signups
  FOR EACH ROW EXECUTE FUNCTION public.money_welcome_kick();
