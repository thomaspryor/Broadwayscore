-- Critic correction requests and owner-only reach (BRO-6984).
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
--   DROP TABLE IF EXISTS public.critic_reach;

ALTER TABLE public.critic_requests DROP CONSTRAINT IF EXISTS critic_requests_kind_check;
ALTER TABLE public.critic_requests ADD CONSTRAINT critic_requests_kind_check
  CHECK (kind IN ('score_flag', 'review_flag', 'missing_review'));

ALTER TABLE public.critic_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS critic_requests_slug_created ON public.critic_requests (critic_slug, created_at DESC);

-- Reach: unique people who visited show pages featuring a critic's reviews in
-- the last 30 days (PostHog). Written daily by scripts/critic-reach.ts
-- (critic-reach.yml, service role) for claimed pages only; read by
-- /api/critics/me (service role) and shown only to the page's owner.
-- Counts only, no personal data. RLS on with no client policies.
CREATE TABLE IF NOT EXISTS public.critic_reach (
  critic_slug text PRIMARY KEY CHECK (critic_slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  people      integer NOT NULL CHECK (people >= 0),
  views       integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  show_pages  integer NOT NULL DEFAULT 0 CHECK (show_pages >= 0),
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.critic_reach ENABLE ROW LEVEL SECURITY;
