-- Broadway Scorecard — Supabase Schema
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- Creates tables for user profiles, reviews, and watchlist

-- 1. Profiles table (auto-created on signup via trigger)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  default_visibility TEXT NOT NULL DEFAULT 'private' CHECK (default_visibility IN ('public', 'private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Reviews table (multiple viewings per show allowed)
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  rating NUMERIC(2,1) NOT NULL CHECK (rating >= 0.5 AND rating <= 5),
  review_text TEXT,
  date_seen DATE,
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Watchlist table
CREATE TABLE watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  planned_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, show_id)
);

-- 4. Lists table (user-created collections of shows)
CREATE TABLE lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_ranked BOOLEAN NOT NULL DEFAULT false,
  is_public BOOLEAN NOT NULL DEFAULT false,
  share_slug TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. List items table (shows within a list)
CREATE TABLE list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  show_id TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(list_id, show_id)
);

-- Indexes for common queries
CREATE INDEX idx_reviews_user_id ON reviews(user_id);
CREATE INDEX idx_reviews_show_id ON reviews(show_id);
CREATE INDEX idx_reviews_user_show ON reviews(user_id, show_id);
CREATE INDEX idx_watchlist_user_id ON watchlist(user_id);
CREATE INDEX idx_watchlist_user_show ON watchlist(user_id, show_id);
CREATE INDEX idx_lists_user_id ON lists(user_id);
CREATE INDEX idx_lists_share_slug ON lists(share_slug) WHERE share_slug IS NOT NULL;
CREATE INDEX idx_list_items_list_id ON list_items(list_id);
CREATE INDEX idx_list_items_list_show ON list_items(list_id, show_id);

-- Row Level Security (RLS) — users can only access their own data
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_items ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update their own profile
CREATE POLICY "Users can view own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Reviews: users can CRUD their own reviews (Phase 1: private only)
CREATE POLICY "Users can view own reviews"
  ON reviews FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own reviews"
  ON reviews FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own reviews"
  ON reviews FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own reviews"
  ON reviews FOR DELETE
  USING (auth.uid() = user_id);

-- Watchlist: users can CRUD their own watchlist
CREATE POLICY "Users can view own watchlist"
  ON watchlist FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own watchlist"
  ON watchlist FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own watchlist"
  ON watchlist FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own watchlist"
  ON watchlist FOR DELETE
  USING (auth.uid() = user_id);

-- Lists: users can CRUD their own lists
CREATE POLICY "Users can view own lists"
  ON lists FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own lists"
  ON lists FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own lists"
  ON lists FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own lists"
  ON lists FOR DELETE
  USING (auth.uid() = user_id);

-- Public lists: anonymous users can view public lists
CREATE POLICY "Anyone can view public lists"
  ON lists FOR SELECT
  USING (is_public = true);

-- Public profiles: anonymous users can view profiles of public list owners
CREATE POLICY "Anyone can view public list owner profiles"
  ON profiles FOR SELECT
  USING (EXISTS (SELECT 1 FROM lists WHERE lists.user_id = profiles.id AND lists.is_public = true));

-- List items: users can CRUD items in their own lists
CREATE POLICY "Users can view own list items"
  ON list_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM lists WHERE lists.id = list_items.list_id AND lists.user_id = auth.uid()));

CREATE POLICY "Users can insert own list items"
  ON list_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM lists WHERE lists.id = list_items.list_id AND lists.user_id = auth.uid()));

CREATE POLICY "Users can update own list items"
  ON list_items FOR UPDATE
  USING (EXISTS (SELECT 1 FROM lists WHERE lists.id = list_items.list_id AND lists.user_id = auth.uid()));

CREATE POLICY "Users can delete own list items"
  ON list_items FOR DELETE
  USING (EXISTS (SELECT 1 FROM lists WHERE lists.id = list_items.list_id AND lists.user_id = auth.uid()));

-- Public list items: anonymous users can view items of public lists
CREATE POLICY "Anyone can view public list items"
  ON list_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM lists WHERE lists.id = list_items.list_id AND lists.is_public = true));

-- Reorder list items atomically (SECURITY DEFINER — validates list ownership internally)
CREATE OR REPLACE FUNCTION reorder_list_items(p_list_id UUID, p_item_ids UUID[], p_positions REAL[])
RETURNS VOID AS $$
BEGIN
  -- Verify caller owns the list
  IF NOT EXISTS (SELECT 1 FROM lists WHERE id = p_list_id AND user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR i IN 1..array_length(p_item_ids, 1) LOOP
    UPDATE list_items SET position = p_positions[i]
    WHERE id = p_item_ids[i] AND list_id = p_list_id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'avatar_url', NEW.raw_user_meta_data->>'picture', NULL)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER reviews_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- =========================================
-- FANTASY LEAGUE
-- =========================================

-- Fantasy draft entries (no auth required — email-based)
CREATE TABLE fantasy_entries (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL,
  team_name TEXT,
  league_name TEXT,
  picks JSONB NOT NULL,
  total_cost INTEGER NOT NULL,
  picks_prices_snapshot JSONB,
  price_version_at_submission TEXT,
  season TEXT NOT NULL DEFAULT '2025-2026',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(email, season)
);

-- RLS: anon can INSERT (via API route validation). Reads go through
-- fantasy_entries_public (below) — base table is private to protect PII.
ALTER TABLE fantasy_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert fantasy entries"
  ON fantasy_entries FOR INSERT
  TO anon
  WITH CHECK (true);

-- Public-safe view for leaderboard reads. Emails masked server-side,
-- tiebreakers not exposed. See migration 20260420_fantasy_privacy_index.sql.
CREATE OR REPLACE FUNCTION mask_email(email_in TEXT) RETURNS TEXT AS $$
  SELECT CASE
    WHEN email_in IS NULL OR position('@' IN email_in) = 0 THEN NULL
    ELSE substr(email_in, 1, 1) || '***' || substr(email_in, position('@' IN email_in))
  END
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE VIEW fantasy_entries_public AS
SELECT
  id,
  mask_email(email) AS display_email,
  team_name,
  league_name,
  picks,
  total_cost,
  picks_prices_snapshot,
  price_version_at_submission,
  season,
  created_at
FROM fantasy_entries;

ALTER VIEW fantasy_entries_public SET (security_invoker = false);
GRANT SELECT ON fantasy_entries_public TO anon;

CREATE INDEX IF NOT EXISTS idx_fantasy_entries_season_league
  ON fantasy_entries(season, league_name);
