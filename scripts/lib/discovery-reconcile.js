/**
 * Stale-entry reconciliation for scripts/discover-new-shows.js (Gap C, card #1446).
 *
 * checkForDuplicate() / the todaytixId dedup step correctly identify a
 * rediscovered candidate as an existing shows.json entry, then historically
 * did nothing further with it — the existing entry's preview/opening date
 * and venue could sit stale forever. wanted-2022 carried a 2022-10-28 preview
 * date for a show that's actually previewing 2026-10-15 until a session
 * hand-patched the data directly (commit 37daf0f2fba) — the code path that
 * found the match never wrote anything back.
 *
 * Deliberately scoped to shows that haven't started their run yet (status
 * 'announced' or 'upcoming'): an 'open'/'previews' show's dates are already
 * confirmed by the run itself (and may carry a manual correction), and a
 * 'closed' show is historical — discovery re-crawls shouldn't touch either.
 */
function computeShowReconciliation(existing, candidate) {
  if (!existing || !candidate) return null;
  if (existing.status !== 'announced' && existing.status !== 'upcoming') return null;

  const patch = {};

  if (candidate.openingDate && candidate.openingDate !== existing.openingDate) {
    patch.openingDate = candidate.openingDate;
    if (candidate.openingDateSource) patch.openingDateSource = candidate.openingDateSource;
  }
  if (candidate.previewsStartDate && candidate.previewsStartDate !== existing.previewsStartDate) {
    patch.previewsStartDate = candidate.previewsStartDate;
  }
  if (candidate.venue && candidate.venue !== existing.venue) {
    patch.venue = candidate.venue;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

module.exports = { computeShowReconciliation };
