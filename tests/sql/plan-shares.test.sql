-- SQL tests for supabase/migrations/20261001_plan_shares.sql (BRO-4481).
-- Run: bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql tests/sql/plan-shares.test.sql
--
-- Every assertion is t.ok()/t.fails() from tests/fixtures/supabase-stub.sql;
-- the first failure aborts the run (ON_ERROR_STOP). Roles are switched with
-- SET ROLE + t.as_user(), the same way PostgREST runs each request.

-- psql variables are not expanded inside dollar-quoted blocks, so park the
-- parity fixture in a session setting the DO blocks can read.
SELECT set_config('t.fixture', :'parity_fixture', false) \gset

-- ---------------------------------------------------------------- setup ----
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.profiles (id, display_name) VALUES
  ('11111111-1111-1111-1111-111111111111', 'Tom Owner'),
  ('22222222-2222-2222-2222-222222222222', 'Bea Other');

-- Owner A's watchlist + reviews, built from the parity fixture with dates
-- anchored to current_date. A curtain_time is set on every dated row so the
-- "never leaves the database" assertion below has something to catch.
DO $$
DECLARE
  c JSONB;
  r JSONB;
  a UUID := '11111111-1111-1111-1111-111111111111';
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(current_setting('t.fixture')::jsonb -> 'cases') LOOP
    INSERT INTO public.watchlist (user_id, show_id, planned_date, time_slot, curtain_time)
    VALUES (
      a,
      c -> 'show' ->> 'id',
      CASE WHEN c -> 'plannedOffset' = 'null'::jsonb THEN NULL
           ELSE current_date + (c ->> 'plannedOffset')::int END,
      CASE WHEN c -> 'plannedOffset' = 'null'::jsonb THEN NULL ELSE 'evening' END,
      CASE WHEN c -> 'plannedOffset' = 'null'::jsonb THEN NULL ELSE '19:30'::time END
    );
    FOR r IN SELECT * FROM jsonb_array_elements(c -> 'reviews') LOOP
      INSERT INTO public.reviews (user_id, show_id, date_seen, review_text)
      VALUES (
        a,
        c -> 'show' ->> 'id',
        CASE WHEN r -> 'seenOffset' = 'null'::jsonb THEN NULL
             ELSE current_date + (r ->> 'seenOffset')::int END,
        'private review text'
      );
    END LOOP;
  END LOOP;
END $$;

-- User B has their own plans, which must never appear in A's share.
INSERT INTO public.watchlist (user_id, show_id, planned_date)
VALUES ('22222222-2222-2222-2222-222222222222', 'b-only-show', current_date + 3);

-- ------------------------------------------------ owner creates a share ----
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');

INSERT INTO public.plan_shares (user_id, token, display_name)
VALUES ('11111111-1111-1111-1111-111111111111', '00000000000000000000000000000000', '  Tom  ');

SELECT t.ok((SELECT token FROM public.plan_shares) ~ '^[a-f0-9]{32}$', 'insert mints a 32-hex token');
SELECT t.ok((SELECT token FROM public.plan_shares) <> '00000000000000000000000000000000',
            'a client-supplied token is ignored on insert');
SELECT t.ok((SELECT display_name FROM public.plan_shares) = 'Tom', 'display_name is trimmed');

SELECT set_config('t.token_a', (SELECT token FROM public.plan_shares), false) \gset

UPDATE public.plan_shares SET token = 'ffffffffffffffffffffffffffffffff';
SELECT t.ok((SELECT token FROM public.plan_shares) = current_setting('t.token_a'),
            'a client cannot overwrite the token with UPDATE');

UPDATE public.plan_shares SET user_id = '22222222-2222-2222-2222-222222222222';
SELECT t.ok((SELECT count(*) FROM public.plan_shares WHERE user_id = '11111111-1111-1111-1111-111111111111') = 1,
            'a client cannot move the share to another user');

-- The upsert clients use (PostgREST: POST + on_conflict=user_id +
-- resolution=merge-duplicates) must not change the token…
INSERT INTO public.plan_shares (user_id, display_name, show_booked, token)
VALUES ('11111111-1111-1111-1111-111111111111', 'Tom', true, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
ON CONFLICT (user_id) DO UPDATE
  SET display_name = EXCLUDED.display_name, show_booked = EXCLUDED.show_booked, token = EXCLUDED.token;
SELECT t.ok((SELECT token FROM public.plan_shares) = current_setting('t.token_a'),
            'an upsert onto the existing share keeps the token');
-- …and one that omits display_name fails (documented client contract: send
-- the name on every upsert, PATCH for everything else).
SELECT t.fails($$INSERT INTO public.plan_shares (user_id, show_booked)
                 VALUES ('11111111-1111-1111-1111-111111111111', false)
                 ON CONFLICT (user_id) DO UPDATE SET show_booked = EXCLUDED.show_booked$$,
               'an upsert without display_name is refused (clients must send it)');

SELECT t.fails($$UPDATE public.plan_shares SET display_name = '   '$$, 'blank name refused');
SELECT t.fails($$UPDATE public.plan_shares SET display_name = repeat('x', 31)$$, 'name over 30 chars refused');
SELECT t.fails($$INSERT INTO public.plan_shares (user_id, display_name) VALUES ('11111111-1111-1111-1111-111111111111', 'Dup')$$,
               'one share per user');

-- ------------------------------------------------------ other user (B) ----
SELECT t.as_user('22222222-2222-2222-2222-222222222222');
SELECT t.ok((SELECT count(*) FROM public.plan_shares) = 0, 'B cannot see A''s share');
UPDATE public.plan_shares SET enabled = false;
DELETE FROM public.plan_shares;
SELECT t.fails($$INSERT INTO public.plan_shares (user_id, display_name) VALUES ('11111111-1111-1111-1111-111111111111', 'Evil')$$,
               'B cannot create a share for A');
SELECT t.ok(public.rotate_plan_share_token() IS NULL, 'B rotating with no share returns NULL');

RESET ROLE;
SELECT t.ok((SELECT enabled FROM public.plan_shares) AND (SELECT count(*) FROM public.plan_shares) = 1,
            'B''s UPDATE and DELETE touched nothing');
SELECT t.ok((SELECT token FROM public.plan_shares) = current_setting('t.token_a'),
            'B''s rotate did not touch A''s token');

-- -------------------------------------------------------------- anon ----
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails($$SELECT * FROM public.plan_shares$$, 'anon cannot read plan_shares');
SELECT t.fails($$SELECT public.rotate_plan_share_token()$$, 'anon cannot call rotate');
SELECT t.ok((SELECT count(*) FROM public.watchlist) = 0, 'anon still cannot read watchlist rows directly');

SELECT set_config('t.payload', public.get_shared_plans(current_setting('t.token_a'))::text, false) \gset

SELECT t.ok(current_setting('t.payload') <> '', 'anon can read a valid share');
SELECT t.ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(current_setting('t.payload')::jsonb) k)
            = ARRAY['entries', 'name', 'showBooked', 'showUnbooked'],
            'payload has exactly name/showBooked/showUnbooked/entries');
SELECT t.ok(current_setting('t.payload')::jsonb ->> 'name' = 'Tom', 'payload name is the share''s display_name');
SELECT t.ok(NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(current_setting('t.payload')::jsonb -> 'entries') e,
                            jsonb_object_keys(e) k
               WHERE k NOT IN ('show_id', 'planned_date', 'logged')),
            'entries carry only show_id/planned_date/logged');
SELECT t.ok(position('19:30' IN current_setting('t.payload')) = 0
            AND position('evening' IN current_setting('t.payload')) = 0
            AND position('private review text' IN current_setting('t.payload')) = 0
            AND position('Tom Owner' IN current_setting('t.payload')) = 0
            AND position('11111111' IN current_setting('t.payload')) = 0,
            'no curtain time, slot, review text, profile name or user id anywhere in the payload');
SELECT t.ok(position('b-only-show' IN current_setting('t.payload')) = 0, 'another user''s plans never appear');

-- Parity fixture: inclusion and `logged` for every case.
DO $$
DECLARE
  c JSONB;
  e JSONB;
  payload JSONB := current_setting('t.payload')::jsonb;
BEGIN
  FOR c IN SELECT * FROM jsonb_array_elements(current_setting('t.fixture')::jsonb -> 'cases') LOOP
    SELECT x INTO e FROM jsonb_array_elements(payload -> 'entries') x
     WHERE x ->> 'show_id' = c -> 'show' ->> 'id';
    PERFORM t.ok((e IS NOT NULL) = (c ->> 'sqlIncluded')::boolean,
                 format('parity: %s → included=%s', c ->> 'name', c ->> 'sqlIncluded'));
    IF e IS NOT NULL THEN
      PERFORM t.ok((e ->> 'logged')::boolean = (c ->> 'sqlLogged')::boolean,
                   format('parity: %s → logged=%s', c ->> 'name', c ->> 'sqlLogged'));
    END IF;
  END LOOP;
END $$;

SELECT t.ok(public.get_shared_plans(NULL) IS NULL, 'NULL token → NULL');
SELECT t.ok(public.get_shared_plans('abc') IS NULL, 'malformed token → NULL');
SELECT t.ok(public.get_shared_plans(upper(current_setting('t.token_a'))) IS NULL, 'uppercase token → NULL');
SELECT t.ok(public.get_shared_plans('0123456789abcdef0123456789abcdef') IS NULL, 'unknown token → NULL');

-- PostgREST runs a GET RPC in a READ ONLY transaction and lets a VOLATILE
-- function run there, so VOLATILE alone never kept the token out of URLs
-- (live round-trip caught it, 2026-10-01). A GET must fail with 25006, which
-- PostgREST answers with HTTP 405, even for a valid token.
BEGIN TRANSACTION READ ONLY;
DO $$
BEGIN
  PERFORM public.get_shared_plans(current_setting('t.token_a'));
  RAISE EXCEPTION 'ASSERTION FAILED: get_shared_plans answered inside a read-only transaction (PostgREST GET)';
EXCEPTION WHEN SQLSTATE '25006' THEN
  RAISE NOTICE 'ok - read-only transaction (PostgREST GET) is refused with SQLSTATE 25006 (HTTP 405)';
END $$;
COMMIT;

-- -------------------------------------------------------- section toggles ----
RESET ROLE;
UPDATE public.plan_shares SET show_booked = false;
SET ROLE anon;
SELECT t.ok(NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(public.get_shared_plans(current_setting('t.token_a')) -> 'entries') e
               WHERE (e ->> 'planned_date') IS NOT NULL AND NOT (e ->> 'logged')::boolean),
            'booked off: no unlogged dated rows leave the database');
SELECT t.ok(EXISTS (
              SELECT 1 FROM jsonb_array_elements(public.get_shared_plans(current_setting('t.token_a')) -> 'entries') e
               WHERE e ->> 'show_id' = 'fixture-undated'),
            'booked off: want-to-see rows still returned');

RESET ROLE;
UPDATE public.plan_shares SET show_booked = true, show_unbooked = false;
SET ROLE anon;
SELECT t.ok(NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(public.get_shared_plans(current_setting('t.token_a')) -> 'entries') e
               WHERE (e ->> 'planned_date') IS NULL),
            'want-to-see off: undated rows withheld');
SELECT t.ok(EXISTS (
              SELECT 1 FROM jsonb_array_elements(public.get_shared_plans(current_setting('t.token_a')) -> 'entries') e
               WHERE e ->> 'show_id' = 'fixture-future'),
            'want-to-see off: booked rows still returned');

RESET ROLE;
UPDATE public.plan_shares SET show_booked = false, show_unbooked = false;
SET ROLE anon;
SELECT t.ok(public.get_shared_plans(current_setting('t.token_a')) IS NULL, 'both sections off → NULL');

RESET ROLE;
UPDATE public.plan_shares SET show_booked = true, show_unbooked = true, enabled = false;
SET ROLE anon;
SELECT t.ok(public.get_shared_plans(current_setting('t.token_a')) IS NULL, 'stopped sharing → NULL');

-- ------------------------------------------------------------- rotate ----
RESET ROLE;
UPDATE public.plan_shares SET enabled = true;
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
SELECT set_config('t.token_new', public.rotate_plan_share_token(), false) \gset
SELECT t.ok(current_setting('t.token_new') ~ '^[a-f0-9]{32}$'
            AND current_setting('t.token_new') <> current_setting('t.token_a'),
            'rotate returns a new token');
SELECT t.ok(public.get_shared_plans(current_setting('t.token_a')) IS NULL, 'old token dead after rotate');
SELECT t.ok(public.get_shared_plans(current_setting('t.token_new')) IS NOT NULL,
            'new token works (authenticated can read too)');
UPDATE public.plan_shares SET token = 'ffffffffffffffffffffffffffffffff';
SELECT t.ok((SELECT token FROM public.plan_shares) = current_setting('t.token_new'),
            'rotate flag does not leak into later updates in the session');

-- ---------------------------------------------------------------- cap ----
RESET ROLE;
INSERT INTO public.watchlist (user_id, show_id)
SELECT '11111111-1111-1111-1111-111111111111', 'bulk-' || g FROM generate_series(1, 310) g;
SET ROLE anon;
SELECT t.ok(jsonb_array_length(public.get_shared_plans(current_setting('t.token_new')) -> 'entries') = 300,
            'entries capped at 300');
SELECT t.ok(EXISTS (
              SELECT 1 FROM jsonb_array_elements(public.get_shared_plans(current_setting('t.token_new')) -> 'entries') e
               WHERE e ->> 'show_id' = 'fixture-future'),
            'the cap keeps older booked rows when 310 newer undated rows exist');

RESET ROLE;
SELECT t.ok(NOT has_function_privilege('anon', 'public.rotate_plan_share_token()', 'EXECUTE'),
            'grant check: anon has no EXECUTE on rotate');
SELECT t.ok(has_function_privilege('anon', 'public.get_shared_plans(text)', 'EXECUTE'),
            'grant check: anon can EXECUTE get_shared_plans');
-- Whichever function the trigger runs (plan_shares_guard until
-- 20261004_diary_shares.sql replaced it with the shared share_token_guard).
SELECT t.ok(NOT has_function_privilege('authenticated',
              (SELECT tg.tgfoid FROM pg_trigger tg WHERE tg.tgname = 'plan_shares_guard'), 'EXECUTE'),
            'grant check: nobody can call the guard directly');
SELECT t.ok(NOT has_table_privilege('authenticated', 'public.plan_shares', 'TRUNCATE'),
            'grant check: authenticated cannot TRUNCATE plan_shares');
SELECT t.ok((SELECT provolatile FROM pg_proc WHERE proname = 'get_shared_plans') = 'v',
            'get_shared_plans is VOLATILE (never cached; GET is refused by its read-only check, tested above)');
