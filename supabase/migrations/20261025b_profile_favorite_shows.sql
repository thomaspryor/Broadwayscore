-- Stats "Your favorites" in the iOS app (owner 2026-10-25): three ranked
-- favorite shows per account.
--
--   profiles.favorite_show_ids  Positional slots: index 0 is No. 1. NULL
--                               elements are empty slots (No. 3 can be filled
--                               before No. 2). At most three elements.
--
-- The app reads it through profiles select('*') and writes it with an update
-- on the caller's own row. Existing RLS already covers that: "Users can update
-- own profile" (USING auth.uid() = id) is the only UPDATE policy, so nobody
-- can write another account's favorites. No new policy is needed.
-- A missing column reads as undefined in the app (empty slots), so the code
-- can ship before or after this is applied; saving needs the column.
--
-- The GRANT is belt-and-braces: profiles uses table-level grants (the
-- onboarding_seen_at column, 20261005, needed none), and a column grant on
-- top of a table grant changes nothing. It only matters if authenticated
-- ever moves to column-level grants. anon gets nothing new.
--
-- Owner approved applying this to production 2026-10-25 (BRO-6220 session).
-- Applied with .github/workflows/apply-migration.yml.
--
-- Re-runnable. ROLLBACK (app code reverted first):
--   ALTER TABLE public.profiles DROP COLUMN IF EXISTS favorite_show_ids;

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS favorite_show_ids TEXT[];

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_favorite_show_ids_max3;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_favorite_show_ids_max3
  CHECK (favorite_show_ids IS NULL OR cardinality(favorite_show_ids) <= 3);

GRANT SELECT (favorite_show_ids), UPDATE (favorite_show_ids) ON public.profiles TO authenticated;

COMMENT ON COLUMN public.profiles.favorite_show_ids IS
  'Stats "Your favorites" (iOS, 2026-10-25): up to 3 show ids, index 0 = No. 1, NULL = empty slot.';
