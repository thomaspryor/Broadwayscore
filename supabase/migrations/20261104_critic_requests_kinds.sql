-- Critic correction requests (BRO-6984).
--
-- A critic who owns their page (approved claim) can now flag any problem with
-- one of their reviews (wrong score, not my review, wrong show, other) and
-- tell us about a missing review. Both are stored in critic_requests next to
-- the existing 'score_flag' kind and emailed to the owner. Nothing here reads
-- or writes a score or a review.
--
-- Access is unchanged from 20261103_critic_claims.sql: RLS is enabled with NO
-- client policies, so anon and authenticated users can neither read nor write
-- any row. The only writer is /api/critics/flag (service role), which first
-- verifies the caller's Supabase JWT and that the account holds the approved
-- claim on that page, then rate-limits it. Only the service role reads rows.
--
-- Additive and re-runnable; safe before or after the app code ships.
-- ROLLBACK (app code reverted first):
--   DELETE FROM public.critic_requests WHERE kind <> 'score_flag';
--   ALTER TABLE public.critic_requests DROP CONSTRAINT IF EXISTS critic_requests_kind_check;
--   ALTER TABLE public.critic_requests ADD CONSTRAINT critic_requests_kind_check CHECK (kind IN ('score_flag'));

ALTER TABLE public.critic_requests DROP CONSTRAINT IF EXISTS critic_requests_kind_check;
ALTER TABLE public.critic_requests ADD CONSTRAINT critic_requests_kind_check
  CHECK (kind IN ('score_flag', 'review_flag', 'missing_review'));

ALTER TABLE public.critic_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS critic_requests_slug_created ON public.critic_requests (critic_slug, created_at DESC);
