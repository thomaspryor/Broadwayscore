-- Minimal stand-in for a Supabase project, for testing migrations against a
-- throwaway local Postgres (scripts/test-plan-shares-sql.sh). It reproduces the
-- three things RLS and grant tests depend on, and nothing else:
--
--   1. The `anon` / `authenticated` roles PostgREST switches into.
--   2. `auth.uid()`, read from the same request setting PostgREST populates.
--   3. Supabase's DEFAULT PRIVILEGES: every new table AND function in `public`
--      is granted to anon + authenticated. This is the one people forget: a
--      migration that only does `REVOKE ... FROM PUBLIC` still leaves a
--      function callable by anon on a real project. Mirroring it here makes
--      that mistake fail locally instead of in production.
--
-- Table shapes are copied from supabase-schema.sql and
-- supabase/migrations/20260809_watchlist_showtime.sql (only the columns the
-- migrations under test read).

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
-- The cron/CI key's role; BYPASSRLS like the real one (welcome_emails test).
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- email / email_confirmed_at / created_at / raw_user_meta_data / deleted_at are the real GoTrue
-- columns 20261004b_welcome_emails.sql reads; defaults keep older tests'
-- id-only inserts working.
CREATE TABLE auth.users (
  id UUID PRIMARY KEY,
  email TEXT,
  email_confirmed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_user_meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ
);

-- Supabase reads request.jwt.claim.sub (legacy) / request.jwt.claims (json).
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated;

CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  rating NUMERIC(2,1) NOT NULL DEFAULT 4,
  review_text TEXT,
  date_seen DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  planned_date DATE,
  time_slot TEXT,
  curtain_time TIME,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, show_id)
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.watchlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile" ON public.profiles FOR ALL USING (auth.uid() = id);
CREATE POLICY "own reviews" ON public.reviews FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "own watchlist" ON public.watchlist FOR ALL USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Test helpers (live in their own schema so they never look like app objects).
-- Both are SECURITY INVOKER: they run as whatever role the test has SET ROLE'd
-- into, which is the point.
-- ---------------------------------------------------------------------------
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO anon, authenticated, service_role;

CREATE FUNCTION t.ok(cond BOOLEAN, msg TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSERTION FAILED: %', msg;
  END IF;
  RAISE NOTICE 'ok - %', msg;
END $$;

-- Passes only if `stmt` raises. Use for "this role must not be able to …".
CREATE FUNCTION t.fails(stmt TEXT, msg TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'ok - % (raised: %)', msg, SQLERRM;
    RETURN;
  END;
  RAISE EXCEPTION 'ASSERTION FAILED: % (statement succeeded: %)', msg, stmt;
END $$;

-- Act as a signed-in user (or anon when uid is NULL) for the rest of the
-- session, the way PostgREST does per request.
CREATE FUNCTION t.as_user(uid UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', coalesce(uid::text, ''), false);
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO anon, authenticated, service_role;
