-- Record push_tokens' current policies in the web repo. ALREADY LIVE IN PROD.
--
-- push_tokens belongs to the iOS app. Its migration
-- BroadwayScorecard-app/supabase/migrations/20260812094500_push_tokens_close_cross_account_attach.sql
-- was applied to prod on 2026-08-12 (BroadwayScorecard-app run 31623215228,
-- verified by run 31623332784). It dropped "Anon can insert push tokens"
-- because that policy checked the token's shape but never its owner, so any
-- signed-in user could attach a device token to another account.
--
-- verify-schema.yml builds its expectations from THIS repo's migrations only,
-- so it still expected the dropped policy (declared by
-- 20260422_security_advisor_fixes.sql) and has been red since 2026-08-17 with
--   missing in prod: policy push_tokens:Anon can insert push tokens
-- This file mirrors the iOS migration's statements verbatim so the expected
-- set matches prod: push_tokens_owner_insert + push_tokens_claim_update.
--
-- Do NOT "fix" verify-schema by re-creating "Anon can insert push tokens":
-- that re-opens the cross-account attach hole. There is no need to apply this
-- file (prod already has exactly this state); applying it is a no-op rewrite
-- of the same two policies. Change push_tokens policies in the iOS repo first,
-- where the adversarial RLS tests for this table live, then mirror them here.

alter table public.push_tokens enable row level security;

drop policy if exists "Anon can insert push tokens" on public.push_tokens;
drop policy if exists "push_tokens_owner_insert" on public.push_tokens;
drop policy if exists "push_tokens_owner_update" on public.push_tokens;
drop policy if exists "Users can update their own tokens" on public.push_tokens;
drop policy if exists "push_tokens_claim_update" on public.push_tokens;

create policy "push_tokens_owner_insert"
  on public.push_tokens
  for insert
  to authenticated, anon
  with check (
    char_length(token) >= 8
    and char_length(token) <= 4096
    and platform = any (array['ios'::text, 'android'::text, 'web'::text])
    and (user_id is null or user_id = (select auth.uid()))
  );

create policy "push_tokens_claim_update"
  on public.push_tokens
  for update
  to authenticated, anon
  using (true)
  with check (user_id is null or user_id = (select auth.uid()));
