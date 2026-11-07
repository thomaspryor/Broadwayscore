-- Fantasy entry insert rules (BRO-5424). Run by tests/unit/fantasy-entries-sql.test.mjs
-- after every migration that touches fantasy_entries, in filename order.

-- The draft route's insert (no RETURNING) works for anon.
SET ROLE anon;
INSERT INTO public.fantasy_entries (email, picks, total_cost, season)
  VALUES ('ok@example.com', '["wanted-2022","evita-2027"]', 57, '2026-2027');
RESET ROLE;
SELECT t.ok((SELECT count(*) FROM public.fantasy_entries WHERE email = 'ok@example.com') = 1,
  'anon plain insert (the draft route) succeeds');

-- Backdating is ignored: created_at is the server clock.
SET ROLE anon;
INSERT INTO public.fantasy_entries (email, picks, total_cost, season, created_at)
  VALUES ('backdate@example.com', '["wanted-2022"]', 23, '2026-2027', '2026-09-30T12:00:00Z');
RESET ROLE;
SELECT t.ok((SELECT created_at > now() - interval '1 minute' FROM public.fantasy_entries WHERE email = 'backdate@example.com'),
  'a client-supplied created_at is replaced with now()');

-- Row shapes that would crash the leaderboard or exceed the roster are refused.
SET ROLE anon;
SELECT t.fails($$INSERT INTO public.fantasy_entries (email, picks, total_cost, season) VALUES ('obj@example.com', '[{"x":1}]', 0, '2026-2027')$$,
  'an object pick is refused');
SELECT t.fails($$INSERT INTO public.fantasy_entries (email, picks, total_cost, season) VALUES ('nest@example.com', '[["a"]]', 0, '2026-2027')$$,
  'a nested-array pick is refused');
SELECT t.fails($$INSERT INTO public.fantasy_entries (email, picks, total_cost, season) VALUES ('nine@example.com', '["a","b","c","d","e","f","g","h","i"]', 0, '2026-2027')$$,
  'nine picks are refused');
SELECT t.fails($$INSERT INTO public.fantasy_entries (email, picks, total_cost, season) VALUES ('none@example.com', '[]', 0, '2026-2027')$$,
  'zero picks are refused');
SELECT t.fails($$INSERT INTO public.fantasy_entries (email, picks, total_cost, season) VALUES ('not-an-email', '["a"]', 0, '2026-2027')$$,
  'a malformed email is still refused');
RESET ROLE;
-- Anon still reads no base-table rows (emails stay private); the masked view still works.
SET ROLE anon;
SELECT t.ok((SELECT count(*) FROM public.fantasy_entries) = 0, 'anon reads no raw fantasy_entries rows');
SELECT t.ok((SELECT count(*) FROM public.fantasy_entries_public) = 2, 'anon reads both entries through the masked view');
RESET ROLE;

SELECT t.ok(true, 'all assertions passed');
