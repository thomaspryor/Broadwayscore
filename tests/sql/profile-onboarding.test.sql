-- SQL tests for supabase/migrations/20261005_profile_onboarding.sql (BRO-4619):
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261005_profile_onboarding.sql \
--     tests/sql/profile-onboarding.test.sql
-- The harness applies the migration to an empty stub first, so the
-- first-apply backfill is exercised at the end by clearing its marker and
-- re-applying the file (the harness's :last_migration copy).

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.profiles (id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'New A'),
  ('22222222-2222-2222-2222-222222222222', 'New B');

SELECT t.ok((SELECT count(*) FROM public.profiles WHERE onboarding_seen_at IS NULL) = 2,
            'profiles created after the migration start unseen');

-- ------------------------------------------------------------- claim ----
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
SELECT t.ok(public.claim_onboarding() IS TRUE, 'first claim returns true');
SELECT t.ok(public.claim_onboarding() IS FALSE, 'second claim returns false (never shown twice)');
RESET ROLE;
SELECT t.ok((SELECT onboarding_seen_at IS NOT NULL FROM public.profiles
              WHERE id = '11111111-1111-1111-1111-111111111111'), 'claim stamps the caller');
SELECT t.ok((SELECT onboarding_seen_at IS NULL FROM public.profiles
              WHERE id = '22222222-2222-2222-2222-222222222222'), 'claim leaves other accounts alone');

-- ------------------------------------------------------------- anon ----
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails('SELECT public.claim_onboarding()', 'anon cannot call claim_onboarding');
RESET ROLE;

-- ------------------------------------------------------ seen_unrated ----
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
INSERT INTO public.seen_unrated (user_id, show_id) VALUES ('11111111-1111-1111-1111-111111111111', 'six-2021');
SELECT t.fails($q$INSERT INTO public.seen_unrated (user_id, show_id) VALUES ('11111111-1111-1111-1111-111111111111', 'six-2021')$q$,
               'one row per show per account');
SELECT t.fails($q$INSERT INTO public.seen_unrated (user_id, show_id) VALUES ('22222222-2222-2222-2222-222222222222', 'six-2021')$q$,
               'cannot write a row for someone else');
SELECT t.as_user('22222222-2222-2222-2222-222222222222');
SELECT t.ok((SELECT count(*) FROM public.seen_unrated) = 0, 'cannot read someone else''s rows');
DELETE FROM public.seen_unrated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
SELECT t.ok((SELECT count(*) FROM public.seen_unrated) = 1, 'own row readable, untouched by another account''s delete');
DELETE FROM public.seen_unrated WHERE show_id = 'six-2021';
SELECT t.ok((SELECT count(*) FROM public.seen_unrated) = 0, 'can delete own row');
INSERT INTO public.seen_unrated (user_id, show_id) VALUES ('11111111-1111-1111-1111-111111111111', 'six-2021');
RESET ROLE;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails('SELECT count(*) FROM public.seen_unrated', 'anon cannot read seen_unrated');
RESET ROLE;

-- ------------------------------------------------------------ re-run ----
-- Re-applying must NOT backfill B (a new account that has not seen it yet).
\i :last_migration
SELECT t.ok((SELECT onboarding_seen_at IS NULL FROM public.profiles
              WHERE id = '22222222-2222-2222-2222-222222222222'), 're-apply does not hide the welcome from new accounts');

-- -------------------------------------------------- first-apply backfill ----
-- Without the marker comment the file behaves like its first apply on prod:
-- every account that already exists is stamped and will never see the sheet.
-- Prod has this trigger (supabase-schema.sql); the stub does not.
UPDATE public.profiles SET onboarding_seen_at = NULL, updated_at = '2020-01-01';
CREATE FUNCTION public.t_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.t_touch();
COMMENT ON COLUMN public.profiles.onboarding_seen_at IS NULL;
\i :last_migration
SELECT t.ok((SELECT bool_and(updated_at = '2020-01-01') FROM public.profiles),
            'backfill leaves updated_at alone');
SELECT t.ok((SELECT tgenabled = 'O' FROM pg_trigger WHERE tgname = 'profiles_updated_at'),
            'backfill turns the updated_at trigger back on');
SELECT t.ok((SELECT count(*) FROM public.profiles WHERE onboarding_seen_at IS NULL) = 0,
            'first apply backfills every existing account');
SELECT t.ok(col_description('public.profiles'::regclass,
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.profiles'::regclass AND attname = 'onboarding_seen_at')) IS NOT NULL,
            'first apply leaves the marker comment');
SELECT t.ok((SELECT count(*) FROM public.seen_unrated) = 1, 're-apply keeps seen_unrated rows');
DELETE FROM public.profiles WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT t.ok((SELECT count(*) FROM public.seen_unrated) = 0, 'deleting the account deletes its seen_unrated rows');
