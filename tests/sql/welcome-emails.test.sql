-- SQL tests for supabase/migrations/20261004b_welcome_emails.sql (BRO-4620).
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261004b_welcome_emails.sql \
--     tests/sql/welcome-emails.test.sql

-- ---------------------------------------------------------------- setup ----
INSERT INTO auth.users (id, email, created_at, raw_user_meta_data, deleted_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'old@example.com',    now() - interval '30 days', '{}', NULL),
  ('22222222-2222-2222-2222-222222222222', 'new@example.com',    now() - interval '1 hour',  '{"full_name":"Meta Name"}', NULL),
  ('33333333-3333-3333-3333-333333333333', 'abc@privaterelay.appleid.com', now() - interval '30 minutes', '{}', NULL),
  ('44444444-4444-4444-4444-444444444444', NULL,                 now() - interval '20 minutes', '{}', NULL),
  ('55555555-5555-5555-5555-555555555555', 'gone@example.com',   now() - interval '10 minutes', '{}', now());
INSERT INTO auth.users (id, email, email_confirmed_at, created_at) VALUES
  ('66666666-6666-6666-6666-666666666666', 'unconfirmed@example.com', NULL, now() - interval '5 minutes');
INSERT INTO public.profiles (id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Old Timer'),
  ('22222222-2222-2222-2222-222222222222', ''),
  ('33333333-3333-3333-3333-333333333333', 'Apple Person');

-- ---------------------------------------------------- anon/users locked out ----
SET ROLE authenticated;
SELECT t.as_user('22222222-2222-2222-2222-222222222222');
SELECT t.fails($$SELECT * FROM public.welcome_email_candidates(now() - interval '1 day', 10)$$,
               'authenticated cannot call welcome_email_candidates (it reads auth.users emails)');
SELECT t.fails($$INSERT INTO public.welcome_emails (user_id) VALUES ('22222222-2222-2222-2222-222222222222')$$,
               'authenticated cannot write welcome_emails');
SELECT t.fails($$SELECT * FROM public.welcome_emails$$,
               'authenticated cannot read welcome_emails');
RESET ROLE;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails($$SELECT * FROM public.welcome_email_candidates(now() - interval '1 day', 10)$$,
               'anon cannot call welcome_email_candidates');
RESET ROLE;

-- ------------------------------------------------------ service role path ----
SET ROLE service_role;
SELECT t.ok((SELECT count(*) FROM public.welcome_email_candidates(now() - interval '1 day', 10)) = 2,
            'candidates: only recent accounts with a confirmed email and not deleted (old, no-email, unconfirmed, deleted excluded)');
SELECT t.ok((SELECT array_agg(id ORDER BY created_at) FROM public.welcome_email_candidates(now() - interval '1 day', 10))
              = ARRAY['22222222-2222-2222-2222-222222222222'::uuid, '33333333-3333-3333-3333-333333333333'::uuid],
            'candidates oldest first; Apple private relay address included');
SELECT t.ok((SELECT display_name FROM public.welcome_email_candidates(now() - interval '1 day', 10)
              WHERE id = '22222222-2222-2222-2222-222222222222') = 'Meta Name',
            'empty profile display_name falls back to OAuth full_name');
SELECT t.ok((SELECT count(*) FROM public.welcome_email_candidates(now() - interval '1 day', 1)) = 1,
            'p_limit caps the result');

-- The claim: first insert wins, a second is a no-op (ON CONFLICT DO NOTHING),
-- exactly what PostgREST's Prefer: resolution=ignore-duplicates sends.
CREATE TEMP TABLE claim_results (n INT);
WITH ins AS (INSERT INTO public.welcome_emails (user_id) VALUES ('22222222-2222-2222-2222-222222222222')
             ON CONFLICT DO NOTHING RETURNING user_id)
INSERT INTO claim_results SELECT count(*) FROM ins;
WITH ins AS (INSERT INTO public.welcome_emails (user_id) VALUES ('22222222-2222-2222-2222-222222222222')
             ON CONFLICT DO NOTHING RETURNING user_id)
INSERT INTO claim_results SELECT count(*) FROM ins;
SELECT t.ok((SELECT array_agg(n) FROM claim_results) = ARRAY[1, 0],
            'first claim inserts a row; a second claim for the same account inserts nothing');
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.welcome_email_candidates(now() - interval '1 day', 10)
                         WHERE id = '22222222-2222-2222-2222-222222222222'),
            'a claimed account is no longer a candidate');
RESET ROLE;

-- Account deletion cascades the record away.
DELETE FROM auth.users WHERE id = '22222222-2222-2222-2222-222222222222';
SELECT t.ok(NOT EXISTS (SELECT 1 FROM public.welcome_emails WHERE user_id = '22222222-2222-2222-2222-222222222222'),
            'deleting the auth user removes its welcome_emails row');
