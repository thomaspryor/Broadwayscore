-- Critic page claiming (BRO-6895).
--
-- A critic signs in, asks to claim /critics/<slug>, and the owner approves
-- over email (signed link). An approved claim lets that account edit a small
-- public profile (photo, title, bio, links, picks). Scores, rank, averages and
-- reviews live in reviews.json and are never touched by these tables.
--
-- Every write goes through server routes (service role) that verify the
-- caller's Supabase JWT first, so RLS is enabled with NO client write policies.
-- A signed-in user may read only their own claim rows.
--
-- Re-runnable. ROLLBACK (app code reverted first):
--   DROP FUNCTION IF EXISTS public.bump_critic_page_view(text);
--   DROP TABLE IF EXISTS public.critic_opening_notices, public.critic_page_views, public.critic_requests,
--     public.critic_profiles, public.critic_claims;
--   DELETE FROM storage.buckets WHERE id = 'critic-photos';

CREATE TABLE IF NOT EXISTS public.critic_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  critic_slug   text NOT NULL CHECK (critic_slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_email text NOT NULL CHECK (char_length(contact_email) <= 254),
  work_url      text CHECK (work_url IS NULL OR char_length(work_url) <= 500),
  social_links  jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_emailed_at timestamptz,
  note          text CHECK (note IS NULL OR char_length(note) <= 1000),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  notify_opening_night boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
ALTER TABLE public.critic_claims ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.critic_claims ADD COLUMN IF NOT EXISTS owner_emailed_at timestamptz;

-- One approved owner per page; one open request per account and page.
CREATE UNIQUE INDEX IF NOT EXISTS critic_claims_one_approved
  ON public.critic_claims (critic_slug) WHERE status = 'approved';
CREATE UNIQUE INDEX IF NOT EXISTS critic_claims_one_pending
  ON public.critic_claims (user_id, critic_slug) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS critic_claims_user ON public.critic_claims (user_id);

CREATE TABLE IF NOT EXISTS public.critic_profiles (
  critic_slug     text PRIMARY KEY CHECK (critic_slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  photo_path      text,
  job_title       text CHECK (job_title IS NULL OR char_length(job_title) <= 100),
  bio             text CHECK (bio IS NULL OR char_length(bio) <= 300),
  outlets         text[] NOT NULL DEFAULT '{}',
  links           jsonb NOT NULL DEFAULT '[]'::jsonb,
  picks           jsonb NOT NULL DEFAULT '{}'::jsonb,
  pinned_review_key text,
  verified_at     timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Score flags and other critic requests (never edits scores; owner reads email).
CREATE TABLE IF NOT EXISTS public.critic_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  critic_slug text NOT NULL,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('score_flag')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.critic_page_views (
  critic_slug text NOT NULL,
  day         date NOT NULL,
  views       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (critic_slug, day)
);

-- One row per opening-night "your review is in" email, so a critic is never emailed twice for a show.
CREATE TABLE IF NOT EXISTS public.critic_opening_notices (
  critic_slug text NOT NULL,
  show_slug   text NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (critic_slug, show_slug)
);

ALTER TABLE public.critic_opening_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.critic_claims     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.critic_profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.critic_requests   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.critic_page_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS critic_claims_read_own ON public.critic_claims;
CREATE POLICY critic_claims_read_own ON public.critic_claims
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));

-- Atomic daily counter; only the service role may call it.
CREATE OR REPLACE FUNCTION public.bump_critic_page_view(p_slug text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.critic_page_views (critic_slug, day, views)
  VALUES (p_slug, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (critic_slug, day) DO UPDATE SET views = public.critic_page_views.views + 1;
$$;
REVOKE ALL ON FUNCTION public.bump_critic_page_view(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_critic_page_view(text) TO service_role;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('critic-photos', 'critic-photos', true, 1048576, ARRAY['image/jpeg'])
ON CONFLICT (id) DO NOTHING;
