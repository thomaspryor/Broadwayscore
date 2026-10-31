-- SQL tests for supabase/migrations/20261004_diary_shares.sql (BRO-4566).
-- Run after the plans migrations, since this one repoints plan_shares too:
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql \
--     supabase/migrations/20261002_plan_shares_refuse_get.sql \
--     supabase/migrations/20261004_diary_shares.sql tests/sql/diary-shares.test.sql
--
-- Every assertion is t.ok()/t.fails() from tests/fixtures/supabase-stub.sql;
-- the first failure aborts the run. Roles are switched with SET ROLE +
-- t.as_user(), the same way PostgREST runs each request.

-- ---------------------------------------------------------------- setup ----
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.profiles (id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Tom Owner'),
  ('22222222-2222-2222-2222-222222222222', 'Bea Other');

-- Owner A's diary. Every row carries review_text so the "text never leaves
-- unless show_text" assertions have something to catch.
INSERT INTO public.reviews (user_id, show_id, rating, date_seen, review_text, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'wicked-2003',   4.5, current_date - 10, 'Loved it. Went with my sister.', now() - interval '3 days'),
  ('11111111-1111-1111-1111-111111111111', 'wicked-2003',   5.0, current_date - 400, 'Second time, even better.', now() - interval '2 days'),
  ('11111111-1111-1111-1111-111111111111', 'hamilton-2015', 3.0, NULL, '   ', now() - interval '1 day'),
  ('11111111-1111-1111-1111-111111111111', 'six-2021',      4.0, current_date, 'Tonight!', now()),
  ('11111111-1111-1111-1111-111111111111', 'chess-2025',    3.5, current_date + 1, 'Tomorrow: a plan', now()),
  ('11111111-1111-1111-1111-111111111111', 'ragtime-2025',  4.0, current_date + 30, 'A plan, not a diary entry', now()),
  ('11111111-1111-1111-1111-111111111111', 'gypsy-2024',    2.0, current_date - 5, repeat('x', 5000), now() - interval '5 days'),
  -- Owner B's row must never appear on A's link.
  ('22222222-2222-2222-2222-222222222222', 'smash-2025',    1.0, current_date - 1, 'B''s private note', now());

-- ------------------------------------------- plans now uses the generic guard ----
SELECT t.ok(NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'plan_shares_guard'),
            'plan_shares_guard() is gone (replaced by share_token_guard)');
SELECT t.ok((SELECT p.proname FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
              WHERE tg.tgname = 'plan_shares_guard') = 'share_token_guard',
            'plan_shares trigger runs share_token_guard()');
SELECT t.ok((SELECT p.proname FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid
              WHERE tg.tgname = 'diary_shares_guard') = 'share_token_guard',
            'diary_shares trigger runs share_token_guard()');

-- ------------------------------------------------ owner creates a share ----
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');

-- Plans still mint and freeze tokens through the shared guard.
INSERT INTO public.plan_shares (user_id, token, display_name)
VALUES ('11111111-1111-1111-1111-111111111111', '00000000000000000000000000000000', 'Tom');
SELECT t.ok((SELECT token FROM public.plan_shares) <> '00000000000000000000000000000000',
            'plans: client token still ignored on insert');

INSERT INTO public.diary_shares (user_id, token, display_name)
VALUES ('11111111-1111-1111-1111-111111111111', '00000000000000000000000000000000', '  Tom  ');

SELECT t.ok((SELECT token FROM public.diary_shares) ~ '^[a-f0-9]{32}$', 'insert mints a 32-hex token');
SELECT t.ok((SELECT token FROM public.diary_shares) <> '00000000000000000000000000000000',
            'a client-supplied token is ignored on insert');
SELECT t.ok((SELECT display_name FROM public.diary_shares) = 'Tom', 'display_name is trimmed');
SELECT t.ok((SELECT NOT show_text FROM public.diary_shares), 'show_text defaults to false');
SELECT t.ok((SELECT token FROM public.diary_shares) <> (SELECT token FROM public.plan_shares),
            'diary and plans links are different tokens');

SELECT set_config('t.token_a', (SELECT token FROM public.diary_shares), false) \gset

UPDATE public.diary_shares SET token = 'ffffffffffffffffffffffffffffffff';
SELECT t.ok((SELECT token FROM public.diary_shares) = current_setting('t.token_a'),
            'a client cannot overwrite the token with UPDATE');
UPDATE public.diary_shares SET user_id = '22222222-2222-2222-2222-222222222222';
SELECT t.ok((SELECT count(*) FROM public.diary_shares WHERE user_id = '11111111-1111-1111-1111-111111111111') = 1,
            'a client cannot move the share to another user');
INSERT INTO public.diary_shares (user_id, display_name, token)
VALUES ('11111111-1111-1111-1111-111111111111', 'Tom', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name, token = EXCLUDED.token;
SELECT t.ok((SELECT token FROM public.diary_shares) = current_setting('t.token_a'),
            'an upsert onto the existing share keeps the token');
SELECT t.fails($$UPDATE public.diary_shares SET display_name = '   '$$, 'blank name refused');
SELECT t.fails($$UPDATE public.diary_shares SET display_name = repeat('x', 31)$$, 'name over 30 chars refused');
SELECT t.fails($$INSERT INTO public.diary_shares (user_id, display_name) VALUES ('11111111-1111-1111-1111-111111111111', 'Dup')$$,
               'one diary share per user');

-- ------------------------------------------------------ other user (B) ----
SELECT t.as_user('22222222-2222-2222-2222-222222222222');
SELECT t.ok((SELECT count(*) FROM public.diary_shares) = 0, 'B cannot see A''s share');
UPDATE public.diary_shares SET enabled = false, show_text = true;
DELETE FROM public.diary_shares;
SELECT t.fails($$INSERT INTO public.diary_shares (user_id, display_name) VALUES ('11111111-1111-1111-1111-111111111111', 'Evil')$$,
               'B cannot create a share for A');
SELECT t.ok(public.rotate_diary_share_token() IS NULL, 'B rotating with no share returns NULL');

RESET ROLE;
SELECT t.ok((SELECT enabled AND NOT show_text FROM public.diary_shares), 'B''s UPDATE touched nothing');
SELECT t.ok((SELECT count(*) FROM public.diary_shares) = 1, 'B''s DELETE touched nothing');
SELECT t.ok((SELECT token FROM public.diary_shares) = current_setting('t.token_a'),
            'B''s rotate did not touch A''s token');

-- -------------------------------------------------------------- anon ----
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails($$SELECT * FROM public.diary_shares$$, 'anon cannot read diary_shares');
SELECT t.fails($$SELECT public.rotate_diary_share_token()$$, 'anon cannot call rotate');
SELECT t.ok((SELECT count(*) FROM public.reviews) = 0, 'anon still cannot read reviews directly');

SELECT set_config('t.payload', public.get_shared_diary(current_setting('t.token_a'))::text, false) \gset

DO $$
DECLARE
  p JSONB := current_setting('t.payload')::jsonb;
  e JSONB := p -> 'entries';
  ids TEXT[];
BEGIN
  PERFORM t.ok(p ->> 'name' = 'Tom', 'payload carries the name');
  PERFORM t.ok((p ->> 'showText')::boolean = false, 'payload says notes are off');
  PERFORM t.ok((p ->> 'capped')::boolean = false, 'not capped');
  SELECT array_agg(x ->> 'show_id' ORDER BY ord) INTO ids
    FROM jsonb_array_elements(e) WITH ORDINALITY AS a(x, ord);
  PERFORM t.ok(ids = ARRAY['six-2021', 'gypsy-2024', 'wicked-2003', 'wicked-2003', 'hamilton-2015'],
               'rows: newest first, undated last, up to UTC today; got ' || array_to_string(ids, ','));
  PERFORM t.ok(NOT ('ragtime-2025' = ANY (ids)) AND NOT ('chess-2025' = ANY (ids)),
               'future-dated reviews (plans), even tomorrow, never leave');
  PERFORM t.ok(NOT ('smash-2025' = ANY (ids)), 'another user''s review never leaves');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e) x WHERE x ? 'text'),
               'with notes off, NO row carries a text key');
  PERFORM t.ok(NOT (current_setting('t.payload') LIKE '%sister%'), 'note text is nowhere in the payload');
  PERFORM t.ok((SELECT bool_and(x ? 'date_seen' AND x ? 'rating' AND x ? 'show_id') FROM jsonb_array_elements(e) x),
               'every row has show_id, date_seen (null when undated) and rating');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e) x
                           WHERE x ?| ARRAY['id', 'user_id', 'visibility', 'created_at', 'review_text']),
               'no ids, user, visibility, timestamps or raw review_text');
  PERFORM t.ok((SELECT (x ->> 'rating')::numeric FROM jsonb_array_elements(e) x WHERE x ->> 'show_id' = 'gypsy-2024') = 2.0,
               'rating comes through');
END $$;

-- A caller can't widen the window by setting their session time zone
-- (PostgREST honours Prefer: timezone=…); the function pins UTC.
SET timezone = 'Pacific/Kiritimati';
SELECT t.ok(NOT (public.get_shared_diary(current_setting('t.token_a'))::text LIKE '%chess-2025%'),
            'a UTC+14 session still gets nothing past UTC today');
SET timezone = 'Etc/GMT+12';
SELECT t.ok(NOT (public.get_shared_diary(current_setting('t.token_a'))::text LIKE '%chess-2025%'),
            'a UTC-12 session too');
RESET timezone;

SELECT t.ok(public.get_shared_diary('not-a-token') IS NULL, 'malformed token -> NULL');
SELECT t.ok(public.get_shared_diary('0123456789abcdef0123456789abcdef') IS NULL, 'unknown token -> NULL');
SELECT t.ok(public.get_shared_diary(NULL) IS NULL, 'NULL token -> NULL');

-- PostgREST GET = read-only transaction: refused with 25006 even for a valid token.
RESET ROLE;
SET ROLE anon;
BEGIN TRANSACTION READ ONLY;
DO $$
BEGIN
  PERFORM public.get_shared_diary(current_setting('t.token_a'));
  RAISE EXCEPTION 'ASSERTION FAILED: get_shared_diary answered inside a read-only transaction (PostgREST GET)';
EXCEPTION WHEN SQLSTATE '25006' THEN
  RAISE NOTICE 'ok - read-only transaction (PostgREST GET) is refused with SQLSTATE 25006';
END $$;
COMMIT;

-- ------------------------------------------------------ notes switched on ----
RESET ROLE;
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
UPDATE public.diary_shares SET show_text = true;
RESET ROLE;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT set_config('t.payload', public.get_shared_diary(current_setting('t.token_a'))::text, false) \gset
DO $$
DECLARE
  p JSONB := current_setting('t.payload')::jsonb;
  e JSONB := p -> 'entries';
BEGIN
  PERFORM t.ok((p ->> 'showText')::boolean, 'payload says notes are on');
  PERFORM t.ok((SELECT x ->> 'text' FROM jsonb_array_elements(e) x
                 WHERE x ->> 'show_id' = 'wicked-2003' AND x ->> 'date_seen' = (current_date - 10)::text)
               = 'Loved it. Went with my sister.', 'with notes on, text comes through');
  PERFORM t.ok(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(e) x WHERE x ->> 'show_id' = 'hamilton-2015' AND x ? 'text'),
               'a whitespace-only note is left out');
  PERFORM t.ok((SELECT length(x ->> 'text') FROM jsonb_array_elements(e) x WHERE x ->> 'show_id' = 'gypsy-2024') = 4000,
               'long notes are cut to 4,000 characters');
END $$;

-- ------------------------------------------------- stop, reset, re-share ----
RESET ROLE;
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
UPDATE public.diary_shares SET enabled = false;
RESET ROLE;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.ok(public.get_shared_diary(current_setting('t.token_a')) IS NULL, 'a stopped share -> NULL');

RESET ROLE;
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
UPDATE public.diary_shares SET enabled = true;
SELECT set_config('t.token_new', public.rotate_diary_share_token(), false) \gset
SELECT t.ok(current_setting('t.token_new') ~ '^[a-f0-9]{32}$' AND current_setting('t.token_new') <> current_setting('t.token_a'),
            'rotate returns a new token');
SELECT t.ok(coalesce(current_setting('bsc.rotate_token', true), '') = '', 'rotate clears its flag');
UPDATE public.diary_shares SET token = 'ffffffffffffffffffffffffffffffff';
SELECT t.ok((SELECT token FROM public.diary_shares) = current_setting('t.token_new'),
            'after a rotate, a plain UPDATE still cannot set the token');
RESET ROLE;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.ok(public.get_shared_diary(current_setting('t.token_a')) IS NULL, 'the old token is dead after a reset');
SELECT t.ok(public.get_shared_diary(current_setting('t.token_new')) IS NOT NULL, 'the new token works');

-- ------------------------------------------------------------------ cap ----
RESET ROLE;
INSERT INTO public.reviews (user_id, show_id, rating, date_seen)
SELECT '11111111-1111-1111-1111-111111111111', 'bulk-' || g, 3.0, current_date - 1000 - g
  FROM generate_series(1, 1000) g;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT set_config('t.payload', public.get_shared_diary(current_setting('t.token_new'))::text, false) \gset
SELECT t.ok(jsonb_array_length(current_setting('t.payload')::jsonb -> 'entries') = 1000, 'entries capped at 1,000');
SELECT t.ok((current_setting('t.payload')::jsonb ->> 'capped')::boolean, 'capped flag set when there are more');
SELECT t.ok((current_setting('t.payload')::jsonb -> 'entries' -> 0 ->> 'show_id') = 'six-2021',
            'the cap keeps the newest entries');

-- ---------------------------------------------------------------- grants ----
RESET ROLE;
SELECT t.ok(has_function_privilege('anon', 'public.get_shared_diary(text)', 'EXECUTE'), 'anon can call get_shared_diary');
SELECT t.ok(NOT has_function_privilege('anon', 'public.rotate_diary_share_token()', 'EXECUTE'), 'anon cannot call rotate');
SELECT t.ok(has_function_privilege('authenticated', 'public.rotate_diary_share_token()', 'EXECUTE'), 'authenticated can rotate');
SELECT t.ok(NOT has_function_privilege('anon', 'public.share_token_guard()', 'EXECUTE'), 'anon cannot call the guard');
SELECT t.ok((SELECT 'TimeZone=UTC' = ANY (proconfig) FROM pg_proc WHERE proname = 'get_shared_plans'),
            'get_shared_plans is pinned to UTC as well');
-- The behavioural time-zone checks above only bite at some hours of the UTC
-- day; this one bites always.
SELECT t.ok((SELECT 'TimeZone=UTC' = ANY (proconfig) FROM pg_proc WHERE proname = 'get_shared_diary'),
            'get_shared_diary is pinned to UTC');
