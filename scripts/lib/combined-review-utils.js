/**
 * Helpers for the combined-review (joint review) detection pipeline.
 *
 * Used by `scripts/flag-combined-reviews.js` and tests. Per CLAUDE.md §15,
 * extracted to a lib module so unit tests can require() the real function
 * instead of duplicating logic.
 */

/**
 * Strip year suffix and market suffix from a show ID so revival/historical/
 * current variants of the SAME production collapse to one base slug.
 *
 * Examples:
 *   the-lost-boys           → the-lost-boys
 *   the-lost-boys-2026      → the-lost-boys
 *   stranger-things-the-first-shadow-west-end-2023 → stranger-things-the-first-shadow
 *   evita-off-broadway-2025 → evita
 *
 * Used by flag-combined-reviews.js to filter out cross-variant URL collisions
 * (same critic + same URL on `the-lost-boys` and `the-lost-boys-2026` is the
 * same show, NOT a joint review). Joint review = URL spans 2+ DIFFERENT base
 * shows.
 *
 * Order matters: strip year first (`-2026`), THEN market suffix
 * (`-west-end`), because some IDs have both (`...-west-end-2023`). The
 * `-west-end` strip would otherwise leave `-2023` orphaned.
 */
function baseSlug(showId) {
  return String(showId)
    .replace(/-\d{4}$/, '')
    .replace(/-(?:off-broadway|west-end|off-west-end|tour|first-national-tour)$/, '');
}

/**
 * True if idA and idB are same-TITLE siblings per buildSiblingIndex()
 * (scripts/lib/market-routing.js) — e.g. a regional/pre-Broadway run and its
 * Broadway transfer, linked only by sharing a title (not by baseSlug, which
 * doesn't strip market suffixes like "-at-art-regional").
 *
 * flag-combined-reviews.js must NOT flag a URL shared between such a pair as
 * a legitimate joint review: classifyMarketRouting() /
 * audit-sibling-title-misroute.js already own routing that review to exactly
 * ONE of the pair by date proximity. Flagging it isCombinedReview instead
 * lets a stale copy sit in both directories forever, undoing any prior
 * reroute fix the next time this script runs (task #1608 CI gate incident,
 * two-strangers-carry-a-cake-across-new-york, 2026-08-15: a prior --fix'd
 * reroute was silently re-duplicated back into the regional show's dir).
 */
function areSameTitleSiblings(idA, idB, siblingIndex) {
  const data = siblingIndex.get(idA);
  return !!(data && Array.isArray(data.siblings) && data.siblings.some((s) => s.id === idB));
}

/**
 * The combinedWith list flag-combined-reviews.js should write for `showId`
 * given the other shows a URL was seen under. Filters per-entry (not by
 * skipping the whole URL group) so a MIXED group — a same-title sibling AND
 * a genuinely different show sharing the URL (e.g. a roundup article
 * covering both) — still records the real joint-review relationship without
 * the sibling re-duplicating into `showId`'s own combinedWith (a whole-group
 * skip would still list the sibling in a 3+-member mixed group, reintroducing
 * the exact bug areSameTitleSiblings() exists to prevent — caught by
 * /ship-check's Codex reviewer, 2026-08-15).
 *
 * An empty return means every other show sharing the URL was a title-sibling
 * of `showId` — not a joint review at all, so the caller should skip writing
 * isCombinedReview for this entry entirely.
 */
function computeCombinedWith(showId, otherShowIds, siblingIndex) {
  return otherShowIds
    .filter((s) => s !== showId && !areSameTitleSiblings(showId, s, siblingIndex))
    .sort();
}

module.exports = { baseSlug, areSameTitleSiblings, computeCombinedWith };
