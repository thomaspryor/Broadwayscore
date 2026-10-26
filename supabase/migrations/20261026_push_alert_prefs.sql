-- iOS alerts v2 (BRO-6219): per-device notification choices, the closing-date
-- event feed, and the per-user send log. Owner approved 2026-10-25.
--
-- 1. push_tokens gets the device's own choices. They live on the token row
--    (not the account) so they follow the phone, work signed in or out, and
--    match how iOS users think about notifications:
--      reviews_in       'all' | 'saved' | 'off'
--      closing_week     fires once when a To Watch show is 7 days from closing
--      closing_posted   fires once when a To Watch show posts a closing date
--      rate             server-sent "How was <show>?" for devices that cannot
--                       schedule it locally
--      market           'nyc' | 'london' (the app's market picker)
--      local_reminders  the app schedules the 10pm rate reminder itself, so the
--                       server one must skip this device
--    Defaults keep today's behaviour for every token that exists before this
--    runs: reviews_in 'all' (they were broadcast to), rate on, closing off (the
--    app asks existing users once, and turns it on only for new grants).
--
-- 2. set_push_prefs(p_token, ...) writes those columns. push_tokens grants
--    clients no SELECT and a client cannot name its own row any other way than
--    by the token, which is a device secret; the existing claim UPDATE policy
--    (using (true)) already treats knowing the token as the capability, so this
--    adds no new class of access. It still takes care to:
--      - SECURITY DEFINER with search_path '' and schema-qualified names
--      - validate the token length and every value, update WHERE token = p_token
--        only, never touch user_id/platform/token, and coalesce so an omitted
--        argument keeps the stored value
--      - RETURN VOID, so it cannot be used to learn whether a token exists
--      - REVOKE from PUBLIC, then GRANT to anon + authenticated explicitly
--    Policies on push_tokens belong to the iOS repo and are unchanged here.
--
-- 3. show_events: closing-date changes detected from shows.json, written by
--    scripts/write-show-events.js. The unique key is the diff: a (show, type,
--    date) already recorded is never recorded again. `seeded` marks rows
--    written on the very first run, so the dates that already existed when this
--    shipped never read as news. Service role only.
--
-- 4. push_alert_log: one row per alert actually sent to a user, keyed by
--    dedupe_key (e.g. 'closing-posted:hamilton-2015'). The sender looks a key
--    up (within the alert's window) before sending, so a retry or a second
--    daily run does not send twice. The key is deliberately NOT unique:
--    "Closing date announced" repeats for the same show after 30 days, so the
--    window lives in the sender. Runs are serialized by the send workflow's
--    concurrency group. Service role only. Deleted with the account.
--
-- Re-runnable. ROLLBACK (sender and app reverted first):
--   DROP FUNCTION IF EXISTS public.set_push_prefs(text, text, boolean, boolean, boolean, text, boolean);
--   DROP TABLE IF EXISTS public.push_alert_log;
--   DROP TABLE IF EXISTS public.show_events;
--   ALTER TABLE public.push_tokens DROP COLUMN IF EXISTS reviews_in, DROP COLUMN IF EXISTS closing_week,
--     DROP COLUMN IF EXISTS closing_posted, DROP COLUMN IF EXISTS rate, DROP COLUMN IF EXISTS market,
--     DROP COLUMN IF EXISTS local_reminders, DROP COLUMN IF EXISTS prefs_updated_at;

ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS reviews_in TEXT NOT NULL DEFAULT 'all';
ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS closing_week BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS closing_posted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS rate BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS market TEXT;
ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS local_reminders BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.push_tokens ADD COLUMN IF NOT EXISTS prefs_updated_at TIMESTAMPTZ;

ALTER TABLE public.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_reviews_in_check;
ALTER TABLE public.push_tokens ADD CONSTRAINT push_tokens_reviews_in_check
  CHECK (reviews_in IN ('all', 'saved', 'off'));

ALTER TABLE public.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_market_check;
ALTER TABLE public.push_tokens ADD CONSTRAINT push_tokens_market_check
  CHECK (market IS NULL OR market IN ('nyc', 'london'));

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
         prefs_updated_at = now()
   WHERE token = p_token;
END;
$$;

REVOKE ALL ON FUNCTION public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_push_prefs(TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, TEXT, BOOLEAN)
  TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.show_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  show_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('closing-announced', 'closing-moved')),
  value TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seeded BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT show_events_show_type_value_key UNIQUE (show_id, type, value)
);

CREATE INDEX IF NOT EXISTS show_events_detected_at_idx ON public.show_events (detected_at);

ALTER TABLE public.show_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.show_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.show_events TO service_role;

CREATE TABLE IF NOT EXISTS public.push_alert_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_alert_log_user_key_idx ON public.push_alert_log (user_id, dedupe_key, sent_at);

ALTER TABLE public.push_alert_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_alert_log FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_alert_log TO service_role;
