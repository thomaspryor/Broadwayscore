-- Fantasy entries: harden anon inserts before the 2026-27 launch (BRO-5424)
--
-- The anon key ships to every browser, and the anon INSERT policy from
-- 20260422_security_advisor_fixes.sql only checked the email format and that
-- picks was a JSON array. A hand-made REST insert could therefore:
--   * set created_at to any past date. created_at decides which picks earn
--     critic/audience points (shows that had not opened when the entry was
--     drafted) and the box office start date, so backdating buys points for
--     shows whose reviews are already public;
--   * store picks like [{"x":1}], which the leaderboard renders as a React
--     child and throws on, taking the leaderboard down for every player;
--   * store any number of picks.
-- Budget, deadline and show ids are re-checked when the leaderboard is
-- computed (isValidLeaderboardEntry in src/lib/data-fantasy.ts), so here we
-- only enforce what the app cannot check after the fact: the insert time,
-- and a row shape that cannot crash the readers.
--
-- One transaction: the policy is dropped and recreated, and a failure between
-- the two must not leave the table with no INSERT policy (every draft refused).

BEGIN;

CREATE OR REPLACE FUNCTION public.fantasy_entries_force_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS fantasy_entries_force_created_at ON public.fantasy_entries;
CREATE TRIGGER fantasy_entries_force_created_at
  BEFORE INSERT ON public.fantasy_entries
  FOR EACH ROW EXECUTE FUNCTION public.fantasy_entries_force_created_at();

-- Same checks as before, plus: 1 to 8 picks (teamSize in
-- src/config/fantasy-season.json), every pick a string show id. The jsonpath
-- must be strict: lax mode unwraps nested arrays, so [["x"]] would pass.
DROP POLICY IF EXISTS "Anon can insert fantasy entries" ON public.fantasy_entries;
CREATE POLICY "Anon can insert fantasy entries"
  ON public.fantasy_entries
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    email ~* '^[^\s@]+@[^\s@]+\.[^\s@]+$'
    AND picks IS NOT NULL
    AND jsonb_typeof(picks) = 'array'
    AND jsonb_array_length(picks) BETWEEN 1 AND 8
    AND NOT jsonb_path_exists(picks, 'strict $[*] ? (@.type() != "string")')
    AND total_cost >= 0
    AND char_length(season) BETWEEN 4 AND 20
  );

COMMIT;
