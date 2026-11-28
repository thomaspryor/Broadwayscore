-- DB-level rate limits for fantasy_leagues and fantasy_entries (2026-04-22)
--
-- Problem: app-level rate limits live in src/app/api/fantasy/*/route.ts and
-- are bypassed by direct POSTs to /rest/v1/... using the public anon key
-- (which ships to every browser). A bot could spray thousands of
-- format-valid rows through REST without ever hitting our Next.js routes.
--
-- Fix: enforce per-email caps at the database via BEFORE INSERT triggers.
-- These fire regardless of ingress path (REST, RPC, SDK, Next.js route).
--
-- Caps chosen to match or exceed the intentional app-level limits:
--   fantasy_leagues : 5 per created_by per 24h (mirrors api/fantasy/leagues)
--   fantasy_entries : 10 per email per 24h (generous for legit multi-team
--                     drafting; app currently caps at 5/IP/hr per-instance)
--
-- Indexes back the count queries so the triggers stay O(log n) as the
-- tables grow toward thousands of rows.

-- ============================================================================
-- fantasy_leagues: 5 per created_by per 24h
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_fantasy_leagues_created_by_at
  ON public.fantasy_leagues (created_by, created_at);

CREATE OR REPLACE FUNCTION public.enforce_fantasy_leagues_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  recent_count integer;
BEGIN
  SELECT COUNT(*) INTO recent_count
    FROM public.fantasy_leagues
   WHERE created_by = NEW.created_by
     AND created_at > now() - interval '24 hours';

  IF recent_count >= 5 THEN
    RAISE EXCEPTION 'rate_limit_exceeded: max 5 leagues per email per 24h'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_fantasy_leagues_rate_limit ON public.fantasy_leagues;
CREATE TRIGGER trg_fantasy_leagues_rate_limit
  BEFORE INSERT ON public.fantasy_leagues
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_fantasy_leagues_rate_limit();

-- ============================================================================
-- fantasy_entries: 10 per email per 24h
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_fantasy_entries_email_created_at
  ON public.fantasy_entries (email, created_at);

CREATE OR REPLACE FUNCTION public.enforce_fantasy_entries_rate_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  recent_count integer;
BEGIN
  SELECT COUNT(*) INTO recent_count
    FROM public.fantasy_entries
   WHERE email = NEW.email
     AND created_at > now() - interval '24 hours';

  IF recent_count >= 10 THEN
    RAISE EXCEPTION 'rate_limit_exceeded: max 10 entries per email per 24h'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_fantasy_entries_rate_limit ON public.fantasy_entries;
CREATE TRIGGER trg_fantasy_entries_rate_limit
  BEFORE INSERT ON public.fantasy_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_fantasy_entries_rate_limit();
