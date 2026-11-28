-- BRO-8056 phase 2: the show-refresh reader's MUTABLE pointers (home index, kill switch) move
-- from Storage objects to this table, read through PostgREST with the public anon key.
-- Why: measured 2026-11-23 (`show-refresh-store.js --selftest`), Supabase's Storage CDN served
-- the OLD bytes of an overwritten object to anon readers on the authenticated endpoint
-- (cf-cache-status HIT despite "private, no-cache"), as it did through signed URLs. Every
-- visitor-facing reader shares one anon key, so the CDN treats those reads as cacheable.
-- PostgREST responses are not CDN-cached (cf-cache-status DYNAMIC).
-- Immutable show/<id>/<hash>.json slices stay in Storage: their path changes with their
-- content, so a cached copy is always the right bytes.
-- Writes: service role only (single writer, plan R4). Reads: anon may SELECT exactly the rows
-- 'home' and 'kill' (already-public page state) and 'probe' (written only by
-- `show-refresh-store.js --selftest`, which proves overwrite freshness through anon). Re-runnable. Rollback at the bottom.
BEGIN;

CREATE TABLE IF NOT EXISTS public.show_refresh_state (
  key TEXT PRIMARY KEY CHECK (key IN ('home', 'kill', 'probe')),
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.show_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.show_refresh_state FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS show_refresh_state_anon_read ON public.show_refresh_state;
CREATE POLICY show_refresh_state_anon_read ON public.show_refresh_state FOR SELECT TO anon USING (key IN ('home', 'kill', 'probe'));
GRANT SELECT ON public.show_refresh_state TO anon;
GRANT ALL ON public.show_refresh_state TO service_role;

-- Storage: home.json / kill.json are no longer reader objects; anon reads only show/ slices.
DROP POLICY IF EXISTS show_refresh_anon_read ON storage.objects;
CREATE POLICY show_refresh_anon_read ON storage.objects
  FOR SELECT TO anon
  USING (bucket_id = 'show-refresh' AND (storage.foldername(name))[1] = 'show');

COMMIT;

-- Rollback (the reader then reads an error for home/kill, which effectiveKill treats as killed: baseline renders):
-- DROP TABLE IF EXISTS public.show_refresh_state;
