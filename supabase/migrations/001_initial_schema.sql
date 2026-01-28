-- ============================================================
-- Community Ratings Schema for Broadway Scorecard
-- ============================================================
-- Run this in the Supabase SQL Editor after creating the project.
-- Prerequisites: Google OAuth and Magic Link enabled in Auth settings.

-- ============================================================
-- 1. PROFILES TABLE
-- ============================================================
-- Auto-created for each new auth user via trigger.
-- Public read, owner-only update.

CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  bio TEXT CHECK (char_length(bio) <= 500),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Case-insensitive uniqueness on username
CREATE UNIQUE INDEX idx_profiles_username ON public.profiles (lower(username));

-- ============================================================
-- 2. RATINGS TABLE
-- ============================================================
-- Multiple ratings per show allowed (one per date attended).
-- Public read, owner-only insert/update/delete.

CREATE TABLE public.ratings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
  show_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  review_text TEXT CHECK (char_length(review_text) <= 500),
  date_attended DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  -- One rating per user per show per date
  UNIQUE(user_id, show_id, date_attended)
);

CREATE INDEX idx_ratings_show_id ON public.ratings (show_id);
CREATE INDEX idx_ratings_user_id ON public.ratings (user_id);

-- ============================================================
-- 3. COMMUNITY SCORES VIEW
-- ============================================================
-- Regular view (not materialized) — auto-updates on every query.
-- Averages each user's per-show average to prevent one person
-- with many viewings from dominating the score.

CREATE VIEW public.community_scores AS
SELECT
  show_id,
  COUNT(DISTINCT user_id) AS unique_raters,
  COUNT(*) AS total_ratings,
  ROUND(AVG(user_avg)::numeric, 1) AS avg_score
FROM (
  SELECT user_id, show_id, AVG(score) AS user_avg
  FROM public.ratings
  GROUP BY user_id, show_id
) user_averages
GROUP BY show_id;

-- ============================================================
-- 4. AUTO-CREATE PROFILE ON SIGNUP
-- ============================================================
-- When a new user signs up, automatically create a profile
-- with an auto-generated username like "theatergoer_4827".

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, username)
  VALUES (
    NEW.id,
    'theatergoer_' || floor(random() * 9000 + 1000)::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- 5. AUTO-UPDATE updated_at TIMESTAMPS
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER ratings_updated_at
  BEFORE UPDATE ON public.ratings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================

-- Profiles: anyone can read, only owner can update
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are publicly readable"
  ON public.profiles FOR SELECT
  USING (true);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Ratings: anyone can read, only owner can insert/update/delete
ALTER TABLE public.ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ratings are publicly readable"
  ON public.ratings FOR SELECT
  USING (true);

CREATE POLICY "Users can insert their own ratings"
  ON public.ratings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own ratings"
  ON public.ratings FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own ratings"
  ON public.ratings FOR DELETE
  USING (auth.uid() = user_id);
