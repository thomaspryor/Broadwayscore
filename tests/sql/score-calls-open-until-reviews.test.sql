-- BRO-7857: SQL_HARNESS_APPLY_ONCE=3 bash scripts/test-plan-shares-sql.sh supabase/migrations/20261111_score_calls.sql supabase/migrations/20261112_score_call_clear_live.sql supabase/migrations/20261113_score_calls_range50_readers.sql supabase/migrations/20261119_score_calls_open_until_reviews.sql tests/sql/score-calls-open-until-reviews.test.sql
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
-- "today" in New York, the date the backfill and the backstop use.
CREATE TEMP TABLE ny AS SELECT (now() AT TIME ZONE 'America/New_York')::date AS d;
GRANT SELECT ON ny TO PUBLIC;

SET ROLE service_role;
SELECT t.ok(public.sync_score_call_show('opens-today', (SELECT d FROM ny), 70, 60, 80) = 'inserted', 'opening-day show inserted');
SELECT t.ok(public.sync_score_call_show('opened-yday', (SELECT d FROM ny) - 1, 70, 60, 80) = 'inserted', 'show that opened yesterday inserted');
SELECT t.ok(public.sync_score_call_show('opened-3ago', (SELECT d FROM ny) - 3, 70, 60, 80) = 'inserted', 'show that opened 3 days ago inserted');
SELECT t.ok(public.sync_score_call_show('future', (SELECT d FROM ny) + 5, 70, 60, 80) = 'inserted', 'future show inserted');
SELECT t.ok((SELECT closes_at FROM public.score_call_shows WHERE show_id='future') = (((SELECT d FROM ny) + 7)::timestamp AT TIME ZONE 'America/New_York'), 'backstop: 00:00 New York two days after opening');
RESET ROLE;

SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
SELECT t.ok((SELECT forecast FROM public.lock_score_call('opens-today', 66)) = 70, 'opening day with no review live: lock works');
SELECT t.ok((SELECT forecast FROM public.lock_score_call('opened-yday', 66)) = 70, 'day after opening, no review live: lock works');
SELECT t.fails($$SELECT * FROM public.lock_score_call('opened-3ago', 50)$$, 'past the backstop: refused');
SELECT t.fails($$SELECT * FROM public.mark_score_call_reviews_live('future')$$, 'authenticated cannot mark reviews live');
RESET ROLE;
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails($$SELECT * FROM public.mark_score_call_reviews_live('future')$$, 'anon cannot mark reviews live');
RESET ROLE;

-- First review goes live: mark closes it, and the refusal is calls_closed (not "not open yet").
SET ROLE service_role;
SELECT t.ok(public.mark_score_call_reviews_live('opens-today') = 'marked', 'mark closes the show');
SELECT t.ok(public.mark_score_call_reviews_live('opens-today') = 'unchanged', 'mark is idempotent');
SELECT t.ok(public.mark_score_call_reviews_live('nope') = 'not_found', 'unknown show');
RESET ROLE;
SET ROLE authenticated;
SELECT t.as_user('22222222-2222-2222-2222-222222222222');
DO $$ BEGIN PERFORM * FROM public.lock_score_call('opens-today', 50); RAISE EXCEPTION 'expected refusal';
EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'calls_closed' THEN RAISE EXCEPTION 'reviews-live refusal was % (want calls_closed)', SQLERRM; END IF; END $$;
SELECT t.ok(true, 'reviews-live show answers calls_closed');
SELECT t.ok((SELECT called_score FROM public.get_my_score_calls() WHERE show_id='opened-yday') IS NULL, 'B has no call yet');
RESET ROLE;

-- A nightly sync (OR-only) never reopens a marked show; the explicit clear does (false positive), before the backstop.
SET ROLE service_role;
SELECT public.sync_score_call_show('opens-today', (SELECT d FROM ny), 70, 60, 80, false);
SELECT t.ok((SELECT reviews_live FROM public.score_call_shows WHERE show_id='opens-today'), 'sync with no reviews keeps it closed');
SELECT t.ok(public.clear_score_call_reviews_live('opens-today') = 'cleared', 'clear undoes a false positive');
RESET ROLE;

-- Backfill: re-apply the migration with old (opening-day) closes_at rows; only today-or-later rows without live reviews move.
SET ROLE service_role;
UPDATE public.score_call_shows SET closes_at = (opening_date::timestamp AT TIME ZONE 'America/New_York');
SELECT public.mark_score_call_reviews_live('future');
RESET ROLE;
\i :last_migration
SELECT t.ok((SELECT closes_at FROM public.score_call_shows WHERE show_id='opens-today') = (((SELECT d FROM ny) + 2)::timestamp AT TIME ZONE 'America/New_York'), 'backfill reopens today''s show until the backstop');
SELECT t.ok((SELECT closes_at FROM public.score_call_shows WHERE show_id='opened-yday') = (((SELECT d FROM ny) - 1)::timestamp AT TIME ZONE 'America/New_York'), 'backfill leaves yesterday''s show closed');
SELECT t.ok((SELECT closes_at FROM public.score_call_shows WHERE show_id='future') = (((SELECT d FROM ny) + 5)::timestamp AT TIME ZONE 'America/New_York'), 'backfill skips a show with reviews live');
