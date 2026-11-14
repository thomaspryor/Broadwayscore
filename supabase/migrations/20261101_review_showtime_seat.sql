-- BRO-6783: which performance (matinee / evening / custom time) and an optional
-- seat on a diary entry (a `reviews` row). Mirrors 20260809_watchlist_showtime.sql
-- so a plan's time carries straight onto the entry it becomes.
--
-- All three columns are additive and nullable; no backfill. Clients only send
-- these keys when a value is set (or is being cleared), so a bundle that ships
-- before this migration keeps saving ratings exactly as before.
--
-- PRIVACY: seat is the owner's own note. `reviews` RLS is already owner-only
-- for SELECT, and the one cross-user reader (plan_shares, 20261001) only checks
-- row existence. Never add these columns to a public view, RPC or share card.
--
-- ROLLBACK (revert the app code and confirm it is live FIRST):
--   ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_curtain_time_requires_slot;
--   ALTER TABLE reviews DROP COLUMN IF EXISTS seat;
--   ALTER TABLE reviews DROP COLUMN IF EXISTS curtain_time;
--   ALTER TABLE reviews DROP COLUMN IF EXISTS time_slot;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS time_slot TEXT
    CHECK (time_slot IN ('matinee', 'evening', 'custom'));

-- Local wall-clock time in the show market's zone (same as watchlist). NULL
-- with a slot set is legitimate: "Evening" on a past date we have no schedule
-- for is known, its exact curtain time is not.
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS curtain_time TIME;

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS seat TEXT
    CHECK (seat IS NULL OR (char_length(seat) BETWEEN 1 AND 40));

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_curtain_time_requires_slot;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_curtain_time_requires_slot
    CHECK (curtain_time IS NULL OR time_slot IS NOT NULL);

COMMENT ON COLUMN reviews.time_slot IS
  'matinee | evening | custom: which performance the owner saw (BRO-6783)';
COMMENT ON COLUMN reviews.curtain_time IS
  'Local wall-clock curtain time in the show market''s timezone; NULL = unknown';
COMMENT ON COLUMN reviews.seat IS
  'Owner-only free-text seat, e.g. "Dress Circle C14" (max 40 chars). Never public.';
