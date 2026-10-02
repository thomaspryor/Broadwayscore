-- Restore push_tokens' INSERT policy in prod.
--
-- verify-schema.yml has been red since 2026-08-17 with
--   missing in prod: policy push_tokens:Anon can insert push tokens
--   (declared by 20260422_security_advisor_fixes.sql)
-- It was present on 2026-08-10 (verify-schema green) and the only migration
-- applied in between (20260809_watchlist_showtime.sql) never touches
-- push_tokens, so it was dropped by hand. Re-applying 20260422 whole is not
-- safe (its CREATE POLICY statements are not re-runnable), so this re-issues
-- just that policy, idempotently, with the same bounded check.
--
-- Purely additive on purpose: it does not touch whatever else is on the table
-- now (we can't see why the policy was removed), so it can't break the iOS
-- app's token registration. Permissive policies OR together.
--
-- Re-runnable. ROLLBACK: DROP POLICY IF EXISTS "Anon can insert push tokens" ON public.push_tokens;

DROP POLICY IF EXISTS "Anon can insert push tokens" ON public.push_tokens;
CREATE POLICY "Anon can insert push tokens"
  ON public.push_tokens
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    char_length(token) BETWEEN 8 AND 4096
    AND platform IN ('ios', 'android', 'web')
  );
