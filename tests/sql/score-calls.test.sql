-- BRO-7350: bash scripts/test-plan-shares-sql.sh supabase/migrations/20261111_score_calls.sql tests/sql/score-calls.test.sql
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');

-- sync (service role): insert, never null the forecast, skip when no forecast
SET ROLE service_role;
SELECT t.ok(public.sync_score_call_show('open-show', current_date + 5, 77, 66, 85) = 'inserted', 'sync inserts');
SELECT t.ok(public.sync_score_call_show('open-show', current_date + 5, NULL, NULL, NULL) = 'updated', 'sync updates');
SELECT t.ok((SELECT forecast FROM public.score_call_shows WHERE show_id='open-show') = 77, 'null forecast does not overwrite');
SELECT t.ok(public.sync_score_call_show('no-fc', current_date + 5, NULL, NULL, NULL) = 'skipped_no_forecast', 'no forecast, no row');
SELECT t.ok(public.sync_score_call_show('past-show', current_date - 1, 70, 60, 80) = 'inserted', 'past show inserted (closed)');
SELECT t.ok(public.sync_score_call_show('live-show', current_date + 5, 70, 60, 80, true) = 'inserted', 'live-reviews show inserted');
RESET ROLE;

-- anon and signed-out cannot touch anything
SET ROLE anon;
SELECT t.as_user(NULL);
SELECT t.fails($$SELECT * FROM public.score_call_shows$$, 'anon cannot read forecast table');
SELECT t.fails($$SELECT * FROM public.score_calls$$, 'anon cannot read calls');
SELECT t.fails($$SELECT * FROM public.lock_score_call('open-show', 50)$$, 'anon cannot lock');
SELECT t.fails($$SELECT * FROM public.sync_score_call_show('x', current_date+1, 1,1,1)$$, 'anon cannot sync');
RESET ROLE;

-- signed-in user
SET ROLE authenticated;
SELECT t.as_user('11111111-1111-1111-1111-111111111111');
SELECT t.fails($$SELECT * FROM public.score_call_shows$$, 'authenticated cannot read forecast table');
SELECT t.fails($$SELECT * FROM public.sync_score_call_show('x', current_date+1, 1,1,1)$$, 'authenticated cannot sync');
SELECT t.fails($$SELECT * FROM public.score_call_export()$$, 'authenticated cannot export');
SELECT t.fails($$INSERT INTO public.score_calls (user_id, show_id, called_score) VALUES ('11111111-1111-1111-1111-111111111111','open-show',50)$$, 'no direct insert');
SELECT t.fails($$SELECT * FROM public.lock_score_call('open-show', 101)$$, 'out-of-range score refused');
SELECT t.fails($$SELECT * FROM public.lock_score_call('open-show', -1)$$, 'negative score refused');
SELECT t.fails($$SELECT * FROM public.lock_score_call('nope', 50)$$, 'unknown show refused');
SELECT t.fails($$SELECT * FROM public.lock_score_call('past-show', 50)$$, 'closed show refused');
SELECT t.fails($$SELECT * FROM public.lock_score_call('live-show', 50)$$, 'reviews-live show refused');
SELECT t.ok((SELECT forecast FROM public.lock_score_call('open-show', 80)) = 77, 'lock reveals forecast');
SELECT t.fails($$SELECT * FROM public.lock_score_call('open-show', 60)$$, 'second lock refused');
SELECT t.ok((SELECT called_score FROM public.get_my_score_calls() WHERE show_id='open-show') = 80, 'first call stands');
SELECT t.ok((SELECT count(*) FROM public.score_calls) = 1, 'sees own row only');
SELECT t.as_user('22222222-2222-2222-2222-222222222222');
SELECT t.ok((SELECT count(*) FROM public.score_calls) = 0, 'other user sees none of A''s calls');
SELECT t.ok((SELECT count(*) FROM public.get_my_score_calls()) = 0, 'other user get_my is empty');
RESET ROLE;

-- freeze: forecast changes in sync after the lock do not touch the snapshot
SET ROLE service_role;
SELECT public.sync_score_call_show('open-show', current_date + 5, 40, 30, 50);
SELECT t.ok((SELECT forecast_at_lock FROM public.score_calls LIMIT 1) = 77, 'snapshot frozen at lock');
SELECT t.ok(public.sync_score_call_show('past-show', current_date - 1, 10, 1, 20) = 'closed_flags_only', 'closed show forecast frozen');
SELECT t.ok((SELECT forecast FROM public.score_call_shows WHERE show_id='past-show') = 70, 'closed forecast unchanged');
SELECT t.ok((SELECT mean_call FROM public.score_call_export() WHERE show_id='open-show') = 80.0, 'export gives mean');
SELECT t.ok(pg_get_function_result('public.score_call_export()'::regprocedure) NOT LIKE '%user%', 'export has no user ids');
RESET ROLE;
