-- Shared Diary (BRO-4566, docs/specs/shared-diary.md §3.1-3.2): a no-login link
-- to the shows a user has seen, with dates and star ratings; written notes only
-- when the owner turns on show_text (off by default, here too).
--
-- Also replaces plan_shares_guard() with a generic share_token_guard() used by
-- both share tables. Sharing a function NAMED for plans would make the plans
-- rollback (DROP FUNCTION plan_shares_guard) fail, or with CASCADE silently
-- remove the diary guard and re-open client-chosen tokens (plan review,
-- 2026-10-03).
--
-- Tested locally before apply:
--   bash scripts/test-plan-shares-sql.sh supabase/migrations/20261001_plan_shares.sql \
--     supabase/migrations/20261002_plan_shares_refuse_get.sql \
--     supabase/migrations/20261004_diary_shares.sql tests/sql/diary-shares.test.sql
-- and against the live project by scripts/test-ugc-roundtrip.mjs.
--
-- Re-runnable. ROLLBACK (app code reverted first):
--   DROP FUNCTION IF EXISTS public.get_shared_diary(TEXT);
--   DROP FUNCTION IF EXISTS public.rotate_diary_share_token();
--   DROP TABLE IF EXISTS public.diary_shares;   -- drops its trigger too
--   (keep share_token_guard: plan_shares uses it.)

-- ── Generic token guard ─────────────────────────────────────────────────────
-- Same body as plan_shares_guard (20261001). Table-agnostic: it only touches
-- token, user_id, created_at, display_name and updated_at, which every share
-- table must have. Used by: plan_shares, diary_shares. Keep it free of
-- table-specific logic.
--   INSERT: always mint a fresh token, whatever the client sent.
--   UPDATE: keep the old token unless a rotate_*_share_token() function is the
--           caller (it sets a transaction-local flag); never let user_id move.
CREATE OR REPLACE FUNCTION public.share_token_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.token := replace(gen_random_uuid()::text, '-', '');
    NEW.created_at := now();
  ELSE
    IF coalesce(current_setting('bsc.rotate_token', true), '') <> '1' THEN
      NEW.token := OLD.token;
    END IF;
    NEW.user_id := OLD.user_id;
    NEW.created_at := OLD.created_at;
  END IF;
  NEW.display_name := btrim(NEW.display_name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.share_token_guard() FROM PUBLIC, anon, authenticated;

-- Repoint plans at the generic guard, then retire the plans-named one.
DROP TRIGGER IF EXISTS plan_shares_guard ON public.plan_shares;
CREATE TRIGGER plan_shares_guard
  BEFORE INSERT OR UPDATE ON public.plan_shares
  FOR EACH ROW EXECUTE FUNCTION public.share_token_guard();
DROP FUNCTION IF EXISTS public.plan_shares_guard();

-- ── diary_shares ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.diary_shares (
  user_id        UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  -- 32 lowercase hex = 122 random bits. Minted ONLY by share_token_guard().
  token          TEXT NOT NULL UNIQUE
                   DEFAULT replace(gen_random_uuid()::text, '-', '')
                   CHECK (token ~ '^[a-f0-9]{32}$'),
  enabled        BOOLEAN NOT NULL DEFAULT true,
  -- Written notes. Off by default in the database too, so a client that omits
  -- it can never publish text. The web UI labels these "Private Notes".
  show_text      BOOLEAN NOT NULL DEFAULT false,
  display_name   TEXT NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 30),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.diary_shares ENABLE ROW LEVEL SECURITY;

-- Owner-only, all four verbs. anon matches none of them (auth.uid() is NULL).
DROP POLICY IF EXISTS "own diary share select" ON public.diary_shares;
DROP POLICY IF EXISTS "own diary share insert" ON public.diary_shares;
DROP POLICY IF EXISTS "own diary share update" ON public.diary_shares;
DROP POLICY IF EXISTS "own diary share delete" ON public.diary_shares;
CREATE POLICY "own diary share select" ON public.diary_shares
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own diary share insert" ON public.diary_shares
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own diary share update" ON public.diary_shares
  FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own diary share delete" ON public.diary_shares
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON public.diary_shares FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.diary_shares FROM authenticated;

-- CLIENT CONTRACT: same as plan_shares (upsert always carrying display_name,
-- PATCH for changes, never send `token`, reset via rotate_diary_share_token()).

DROP TRIGGER IF EXISTS diary_shares_guard ON public.diary_shares;
CREATE TRIGGER diary_shares_guard
  BEFORE INSERT OR UPDATE ON public.diary_shares
  FOR EACH ROW EXECUTE FUNCTION public.share_token_guard();

CREATE OR REPLACE FUNCTION public.rotate_diary_share_token()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_token TEXT;
BEGIN
  PERFORM set_config('bsc.rotate_token', '1', true);
  UPDATE public.diary_shares
     SET token = replace(gen_random_uuid()::text, '-', '')
   WHERE user_id = auth.uid()
  RETURNING token INTO v_token;
  PERFORM set_config('bsc.rotate_token', '', true);
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION public.rotate_diary_share_token() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rotate_diary_share_token() TO authenticated;

-- ── Public read path ────────────────────────────────────────────────────────
-- Returns NULL, identically, for a malformed, unknown, disabled or reset token.
--
-- What leaves the database (spec §2.3, §3.2):
--   * name, showText, capped;
--   * per review row: show_id, date_seen, rating; `text` ONLY when show_text
--     (the key is absent otherwise, so review_text never leaves the database),
--     trimmed, empty dropped, cut to 4,000 characters.
--   * Rows: undated, or dated up to UTC today. The web server keeps only
--     dates before the VENUE's today (src/lib/shared-diary/select.ts), and no
--     venue's today is later than UTC today + 1, so nothing it shows is cut;
--     later rows are plans, which this link never shows. The function pins
--     timezone = UTC: current_date otherwise follows the caller's session
--     TimeZone, which PostgREST lets a client set (Prefer: timezone=…).
--   * reviews.visibility is ignored: no UI sets or reads it today. If a
--     per-review privacy control ships, honour it here.
--   * Known, tracked elsewhere: a user_show_stubs show_id joins to that
--     table's anon-readable created_by (see 20260714e_user_show_stubs.sql,
--     BRO-4525 follow-up); the plans link and public lists share it.
-- Never selected: ids, user_id, visibility, timestamps, anything from profiles.
-- PostgREST GET runs in a READ ONLY transaction and lets any function run
-- there (20261002_plan_shares_refuse_get.sql), so the function refuses one
-- itself: the token only ever travels in a POST body.
CREATE OR REPLACE FUNCTION public.get_shared_diary(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
SET timezone = 'UTC'
AS $$
DECLARE
  v_share   public.diary_shares%ROWTYPE;
  v_entries JSONB;
  v_capped  BOOLEAN;
  c_cap     CONSTANT INTEGER := 1000;
BEGIN
  IF current_setting('transaction_read_only') = 'on' THEN
    RAISE EXCEPTION 'get_shared_diary must be called with POST'
      USING ERRCODE = '25006';
  END IF;

  IF p_token IS NULL OR p_token !~ '^[a-f0-9]{32}$' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_share
    FROM public.diary_shares
   WHERE token = p_token
     AND enabled;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- One ordering, with id as the final tiebreaker so bulk imports (same
  -- created_at) keep a stable order and a stable set under the cap.
  SELECT coalesce(jsonb_agg(
           jsonb_build_object('show_id', r.show_id, 'date_seen', r.date_seen, 'rating', r.rating)
           -- The text key exists only when the owner shares notes.
           || CASE
                WHEN v_share.show_text AND btrim(coalesce(r.review_text, '')) <> ''
                THEN jsonb_build_object('text', left(btrim(r.review_text), 4000))
                ELSE '{}'::jsonb
              END
           ORDER BY r.date_seen DESC NULLS LAST, r.created_at DESC, r.id DESC), '[]'::jsonb)
    INTO v_entries
    FROM (
      SELECT * FROM public.reviews
       WHERE user_id = v_share.user_id
         AND (date_seen IS NULL OR date_seen <= current_date)
       ORDER BY date_seen DESC NULLS LAST, created_at DESC, id DESC
       LIMIT c_cap
    ) r;

  v_capped := EXISTS (
    SELECT 1 FROM public.reviews
     WHERE user_id = v_share.user_id
       AND (date_seen IS NULL OR date_seen <= current_date)
     OFFSET c_cap LIMIT 1
  );

  RETURN jsonb_build_object(
    'name', v_share.display_name,
    'showText', v_share.show_text,
    'capped', v_capped,
    'entries', v_entries
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_shared_diary(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_shared_diary(TEXT) TO anon, authenticated;

-- Same caller-TimeZone exposure in get_shared_plans (its `current_date - 2`
-- window widens by a day for a client in UTC-12). Pin it without touching
-- its body.
ALTER FUNCTION public.get_shared_plans(TEXT) SET timezone = 'UTC';
