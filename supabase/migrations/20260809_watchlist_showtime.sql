-- Diary sharing + calendar, Phase 0 (spec: docs/specs/diary-sharing-and-calendar.md).
--
-- A planned diary entry is a `watchlist` row carrying `planned_date DATE` and
-- nothing else — there is no time-of-day column anywhere in the schema. Adding
-- to a calendar needs a real curtain time, so it lives here rather than in
-- client state: the iOS app reads the same rows through the same REST helper,
-- so a time held only in web component state would not exist on the phone.
--
-- Both columns are additive and nullable, and no backfill exists. Every
-- pre-existing row keeps working with time_slot IS NULL, which the export path
-- renders as an all-day event.
--
-- ROLLBACK ORDER MATTERS. Vercel deliberately permits overlapping production
-- deploys, so a bundle that PATCHes these columns can still be serving while a
-- rollback runs. Revert the application code and confirm it is live FIRST, then
-- drop. Dropping underneath a live bundle makes every "Set time" save fail:
--   ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS curtain_time_requires_slot;
--   ALTER TABLE watchlist DROP COLUMN IF EXISTS curtain_time;
--   ALTER TABLE watchlist DROP COLUMN IF EXISTS time_slot;
-- Leaving the columns in place is the safer default — they cost nothing empty.
--
-- RLS is untouched. `watchlist` is already owner-only (supabase-schema.sql
-- 110-125) and these columns inherit those policies; Phase 0 shares nothing.

ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS time_slot TEXT
    CHECK (time_slot IN ('matinee', 'evening', 'custom'));

-- Local wall-clock time, NOT timestamptz. The zone belongs to the show's
-- market, not to the row: a 7:30 PM curtain in the West End is 7:30 PM local
-- regardless of where the diary's owner happens to be when they save it.
-- src/lib/calendar/timezone.ts resolves market -> IANA zone at export time.
ALTER TABLE watchlist
  ADD COLUMN IF NOT EXISTS curtain_time TIME;

-- A time with no slot is unreachable through the UI and would render as a
-- labelless chip, so reject it at the database rather than defensively
-- handling it in three client surfaces.
ALTER TABLE watchlist
  DROP CONSTRAINT IF EXISTS curtain_time_requires_slot;
ALTER TABLE watchlist
  ADD CONSTRAINT curtain_time_requires_slot
    CHECK (curtain_time IS NULL OR time_slot IS NOT NULL);

COMMENT ON COLUMN watchlist.time_slot IS
  'matinee | evening | custom — how the curtain time was chosen (Phase 0 calendar export)';
COMMENT ON COLUMN watchlist.curtain_time IS
  'Local wall-clock curtain time in the show market''s timezone; NULL = all-day entry';
