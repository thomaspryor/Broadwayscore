-- Ship-check finding on 39d637c5: ImportShows.tsx fire-and-forgets an insert
-- on every import attempt with no dedup guard, so a user re-importing the
-- same export (or retrying after a partial failure) spams duplicate
-- unresolved rows -- inflating volume and burning resolver attempts on
-- clones of the same show. The client already swallows insert errors
-- (best-effort logging), so a plain unique index turns a repeat row into a
-- silent no-op instead of adding rows to dedupe with.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unmatched_imports_dedup
  ON unmatched_imports (user_id, source, title, COALESCE(venue, ''), COALESCE(date_seen, '1900-01-01'::date));
