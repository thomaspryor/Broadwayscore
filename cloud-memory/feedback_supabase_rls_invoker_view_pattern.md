---
name: Supabase RLS — security_invoker view + SECURITY DEFINER helper
description: When fixing the "security_definer_view" advisor lint, do not add a blanket USING(true) SELECT policy on the base table — that exposes all columns via /rest/v1/{table}. Use a SECURITY DEFINER helper function instead.
type: feedback
originSessionId: 57bf40c6-0205-4c24-9ffb-239885a83e47
archived: true
---
When the Supabase Security Advisor flags a view as `security_definer_view` (ERROR level), the naive fix is:
1. Set `security_invoker = true` on the view
2. Add a SELECT policy on the base table so anon can read through the view

**Do not do step 2 as `USING (true)`.** PostgREST exposes every base table as `/rest/v1/{table}`, which means anon can bypass the view entirely and SELECT any column — including the ones the view was designed to mask (e.g., raw emails, tiebreakers).

**Why:** Caught during /ship-check after 2026-04-22 migration. I "fixed" the advisor ERROR on `fantasy_entries_public` by making it security_invoker and adding a base-table SELECT policy. This undid the 20260420 privacy fix — raw emails were readable via `curl /rest/v1/fantasy_entries?select=email,tiebreakers`. Subagent in /ship-check caught the regression against the prior migration's intent.

**How to apply:** When the base table has PII the view is supposed to mask:
```sql
-- 1. Remove any broad SELECT policy on the base table
DROP POLICY IF EXISTS "Anon can read X" ON public.X;

-- 2. Create a SECURITY DEFINER function that reads the base table and returns
--    only the safe columns (masked where needed). Owned by postgres, so it
--    bypasses RLS on the base table.
CREATE OR REPLACE FUNCTION public.X_masked()
RETURNS TABLE (...safe columns only...)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id, public.mask_email(email) AS display_email, ... FROM public.X
$$;
GRANT EXECUTE ON FUNCTION public.X_masked() TO anon, authenticated;

-- 3. View calls the function. View is security_invoker (passes lint); the
--    helper function (security_definer) is the only sanctioned PII access.
DROP VIEW IF EXISTS public.X_public;
CREATE VIEW public.X_public WITH (security_invoker = true)
  AS SELECT * FROM public.X_masked();
GRANT SELECT ON public.X_public TO anon, authenticated;
```

**Verify the fix:** `curl -H "apikey: <anon>" {URL}/rest/v1/{base_table}?select={masked_column}` should return `[]` (empty array). `curl ... /rest/v1/{public_view}` should return rows with the masked column.

**Migrations that embody this pattern:** `supabase/migrations/20260422b_fantasy_entries_pii_fix.sql`.
