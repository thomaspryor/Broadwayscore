-- Base tables the fantasy migrations build on (BRO-5424). In prod they came
-- from supabase-schema.sql plus a hand-added tiebreakers column; no migration
-- creates them, so tests/sql/fantasy-entries.test.sql loads this first.
-- Also stubs the non-fantasy objects 20260422_security_advisor_fixes.sql
-- touches, so the real migration applies unmodified.
--
-- The harness re-applies every file to prove idempotency. Everything here is
-- created only on the first pass: re-creating the original permissive INSERT
-- policy after the hardening migration would OR it back in and void the test.
DO $fixture$
BEGIN
  IF to_regclass('public.fantasy_entries') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE public.fantasy_entries (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    email TEXT NOT NULL,
    team_name TEXT,
    league_name TEXT,
    picks JSONB NOT NULL,
    total_cost INTEGER NOT NULL,
    season TEXT NOT NULL DEFAULT '2025-2026',
    tiebreakers JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(email, season)
  );
  ALTER TABLE public.fantasy_entries ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Anyone can insert fantasy entries" ON public.fantasy_entries
    FOR INSERT TO anon WITH CHECK (true);
  GRANT SELECT, INSERT ON public.fantasy_entries TO anon, authenticated;

  CREATE TABLE public.push_tokens (token TEXT, platform TEXT);
  ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
  CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
END
$fixture$;
