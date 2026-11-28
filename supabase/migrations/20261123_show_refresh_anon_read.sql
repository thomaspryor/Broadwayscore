-- BRO-8056 phase 2: the site's show-refresh reader reads the private `show-refresh` bucket
-- with the public anon key through /storage/v1/object/authenticated/... .
-- Why not the long-lived signed URLs from phase 1c: Supabase's CDN served the OLD bytes of an
-- overwritten object through an existing signed URL (cf-cache-status HIT, age 23 s+), which is
-- unsafe for the mutable kill.json / home.json. The authenticated endpoint answers
-- "private, no-cache" with cf-cache-status MISS (measured 2026-11-23); `show-refresh-store.js
-- --selftest` proves it for the anon key before any reader is switched on.
-- Scope: SELECT only, anon only, and only the reader's objects (home.json, kill.json and the
-- immutable show/<id>/<hash>.json slices, all already-public page data; held shows are never
-- published). covered.json, health.json and flagged/ stay service-role only. No INSERT /
-- UPDATE / DELETE policy exists for this bucket, so anon cannot write (selftest asserts it).
-- Re-runnable. Rollback at the bottom (commented).
BEGIN;

DROP POLICY IF EXISTS show_refresh_anon_read ON storage.objects;
CREATE POLICY show_refresh_anon_read ON storage.objects
  FOR SELECT TO anon
  USING (
    bucket_id = 'show-refresh'
    AND (name IN ('home.json', 'kill.json') OR (storage.foldername(name))[1] = 'show')
  );

COMMIT;

-- Rollback (the reader then reads "missing", which effectiveKill treats as killed: baseline renders):
-- DROP POLICY IF EXISTS show_refresh_anon_read ON storage.objects;
