-- Welcome step after first sign-in (BRO-4619): remember, per account and on the
-- server, that the one-time welcome sheet was shown, so it never shows twice
-- (across devices and browsers, not only per localStorage).
--
--   profiles.onboarding_seen_at  NULL = never shown. Every profile that exists
--                                when this runs is backfilled, so accounts made
--                                before the welcome step never see it.
--   claim_onboarding()           Atomically stamps the caller's row and returns
--                                true only for the call that stamped it. The
--                                web app shows the sheet only on true, so two
--                                tabs racing after sign-in show it once.
--   seen_unrated                 Shows the person said they saw in the welcome
--                                without stars and without a date. My Shows
--                                lists them under To Be Rated with "Date not
--                                set", so no seen date is ever made up. A row
--                                stops mattering once the show has a review.
--
-- The app reads the column through profiles select('*'): a missing column
-- reads as undefined there, which the app treats as "do not show", so the code
-- can deploy before or after this is applied.
--
-- Tested locally before apply:
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261005_profile_onboarding.sql \
--     tests/sql/profile-onboarding.test.sql
--
-- Re-runnable. ROLLBACK (app code reverted first):
--   DROP TABLE IF EXISTS public.seen_unrated;
--   DROP FUNCTION IF EXISTS public.claim_onboarding();
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS onboarding_seen_at;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS onboarding_seen_at TIMESTAMPTZ;

-- Existing accounts never see the welcome. The backfill runs on the first
-- apply only (the column comment is the marker): on a re-run, a NULL row is a
-- new account that has not seen the welcome yet and must stay NULL.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_description d
    JOIN pg_class c ON c.oid = d.objoid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
    WHERE n.nspname = 'public' AND c.relname = 'profiles'
      AND a.attname = 'onboarding_seen_at'
  ) THEN
    -- The profiles_updated_at trigger would stamp every row's updated_at with
    -- now(); this backfill is bookkeeping, not a profile edit, so keep it off.
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'profiles_updated_at'
                 AND tgrelid = 'public.profiles'::regclass) THEN
      ALTER TABLE public.profiles DISABLE TRIGGER profiles_updated_at;
      UPDATE public.profiles SET onboarding_seen_at = now() WHERE onboarding_seen_at IS NULL;
      ALTER TABLE public.profiles ENABLE TRIGGER profiles_updated_at;
    ELSE
      UPDATE public.profiles SET onboarding_seen_at = now() WHERE onboarding_seen_at IS NULL;
    END IF;
    COMMENT ON COLUMN public.profiles.onboarding_seen_at IS
      'When the web welcome sheet was shown (BRO-4619). NULL = not yet. Backfilled for accounts that existed on 2026-10-05.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.claim_onboarding()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  uid UUID := auth.uid();
  claimed BOOLEAN;
BEGIN
  IF uid IS NULL THEN
    RETURN FALSE;
  END IF;
  UPDATE public.profiles
     SET onboarding_seen_at = now()
   WHERE id = uid AND onboarding_seen_at IS NULL
  RETURNING TRUE INTO claimed;
  RETURN COALESCE(claimed, FALSE);
END $$;

-- Supabase grants every new public function to anon by default.
REVOKE ALL ON FUNCTION public.claim_onboarding() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_onboarding() TO authenticated;

-- "Seen, date not set". Deleted with the account (FK cascade from profiles,
-- which delete-account removes), renamed by scripts/lib/show-id-rename.js.
CREATE TABLE IF NOT EXISTS public.seen_unrated (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, show_id)
);

ALTER TABLE public.seen_unrated ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own seen_unrated" ON public.seen_unrated;
CREATE POLICY "Users can view own seen_unrated" ON public.seen_unrated
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can insert own seen_unrated" ON public.seen_unrated;
CREATE POLICY "Users can insert own seen_unrated" ON public.seen_unrated
  FOR INSERT WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "Users can delete own seen_unrated" ON public.seen_unrated;
CREATE POLICY "Users can delete own seen_unrated" ON public.seen_unrated
  FOR DELETE USING (auth.uid() = user_id);

REVOKE ALL ON public.seen_unrated FROM anon;
GRANT SELECT, INSERT, DELETE ON public.seen_unrated TO authenticated;
