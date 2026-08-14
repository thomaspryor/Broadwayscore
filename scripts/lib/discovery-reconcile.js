const { normalizeTitle, areTitlesSimilar } = require('./deduplication');

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
 *
 * Two further guards added after adversarial review (ship-check, card #1446):
 * - openingDate is only overwritten when BOTH the existing entry's source and
 *   the candidate's source are re-crawlable ones. A curated/human-verified
 *   openingDateSource (e.g. 'review-derived-press-night' — set when a press
 *   night is inferred from actual published reviews) must never be silently
 *   clobbered by a routine TodayTix/Playbill re-listing; West End opening-
 *   night selection depends on that source trust (scripts/lib/opening-night-
 *   selection.js). A candidate date with no source at all is also refused —
 *   writing a new date while leaving the old source label creates an
 *   inconsistent (date, source) pair.
 * - previewsStartDate/venue patches likewise only apply while openingDate is
 *   still re-crawlable (or unset) — once an opening date has been curated by
 *   hand, the whole record is treated as settled rather than picking which
 *   individual fields to still trust.
 *
 * A third guard added after the same review: reconciliation trusts WHICHEVER
 * check matched (todaytixId equality, or any of checkForDuplicate's 9 checks,
 * including its loosest fuzzy/containment ones) as proof this is the same
 * production. scripts/lib/todaytix-dates.js documents that TodayTix recycles
 * show IDs across unrelated productions — the reason unconfirmedStartDate
 * quarantining exists for dates — but nothing quarantined venue, so a
 * recycled-ID or loose-fuzzy false-positive match could silently overwrite a
 * real show's venue with an unrelated production's. Independent of which
 * check matched, require the candidate's title to itself resemble the
 * existing show's title before writing anything.
 */
const RECRAWLABLE_OPENING_DATE_SOURCES = new Set(['playbill', 'ibdb', 'todaytix', null, undefined]);

function titlesResembleEachOther(a, b) {
  const na = normalizeTitle(a || '');
  const nb = normalizeTitle(b || '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  return areTitlesSimilar(na, nb);
}

function computeShowReconciliation(existing, candidate) {
  if (!existing || !candidate) return null;
  if (existing.status !== 'announced' && existing.status !== 'upcoming') return null;
  if (!RECRAWLABLE_OPENING_DATE_SOURCES.has(existing.openingDateSource)) return null;
  if (!titlesResembleEachOther(existing.title, candidate.title)) return null;

  const patch = {};

  if (candidate.openingDate && candidate.openingDateSource &&
      candidate.openingDate !== existing.openingDate) {
    patch.openingDate = candidate.openingDate;
    patch.openingDateSource = candidate.openingDateSource;
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
