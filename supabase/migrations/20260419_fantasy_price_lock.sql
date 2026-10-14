-- Fantasy Entries — price lock at submission time
-- EV-based pricing refreshes weekly as Gold Derby odds shift. Users should see
-- the prices they drafted at, not current prices. total_cost already preserved
-- the budget check but per-pick prices were lost on reprice.
--
-- picks_prices_snapshot: JSONB {showId: price} captured at submission.
-- price_version_at_submission: ISO timestamp of fantasy-league.json at submission
--   (reads from config._meta.pricing.repricedAt if present, else generatedAt).

ALTER TABLE fantasy_entries
  ADD COLUMN IF NOT EXISTS picks_prices_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS price_version_at_submission TEXT;
