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
  const dataA = siblingIndex.get(idA);
  if (dataA && Array.isArray(dataA.siblings) && dataA.siblings.some((s) => s.id === idB)) return true;
  // Checked both directions on purpose — not just belt-and-suspenders.
  // buildSiblingIndex() (market-routing.js) drops a show from its
  // counterpart's .siblings array via .filter(x => x.year || x.openingDate),
  // so a sibling with neither a -YYYY-suffixed id NOR an openingDate set is
  // invisible from the OTHER side's list even though the reverse direction
  // still finds it — an asymmetric relation that would silently reintroduce
  // the exact re-duplication bug this function exists to prevent for any
  // newly-tracked/provisional sibling show missing both signals (code-review
  // finding, 2026-08-15; dormant today only because current shows.json is
  // 100% year-suffixed).
  const dataB = siblingIndex.get(idB);
  return !!(dataB && Array.isArray(dataB.siblings) && dataB.siblings.some((s) => s.id === idA));
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

/**
 * Shows an aggregator roundup explicitly cited a given review URL for.
 *
 * Breaks the combined-review deadlock (BRO-3794). Two guards disagreed about
 * which comes first:
 *
 *   scripts/lib/url-ownership.js  — refuse a 2nd copy of a URL under another
 *                                   show UNLESS the owning copy is already
 *                                   flagged isCombinedReview/isRoundupArticle.
 *   flag-combined-reviews.js      — flag isCombinedReview only once the URL
 *                                   ALREADY appears under 2+ shows.
 *
 * So a genuine multi-show article collected for show A first could never be
 * collected for show B: the flagger waited for a second copy the ownership
 * guard would never let anyone create. The gap was structurally permanent and
 * every remediation pass re-tried it forever — Disruption's la-voce-di-new-york
 * and the-interested-bystander roundups sat uncollectable behind exactly this
 * while the babysitter loop reported them as an open gap run after run.
 *
 * The way out is evidence we already hold and never used: Playbill Verdict /
 * BWW Review Roundup cite these URLs as reviews OF show B. A second,
 * independent publisher saying "this article reviews B" is the same class of
 * signal as "a second copy exists on disk", and it needs no scrape — the gap
 * audit already commits it to data/audit/show-review-gap.json.
 *
 * @param {Array} auditResults  entries from data/audit/show-review-gap.json
 * @param {(url: string) => string|null} normalizeUrl caller's normalizer, so
 *   the citation index is keyed exactly like the on-disk URL index it merges
 *   into (a mismatched normalizer here silently indexes nothing).
 * @returns {Map<string, Set<string>>} normalized URL -> showIds citing it
 */
function buildAggregatorCitationIndex(auditResults, normalizeUrl) {
  const index = new Map();
  if (!Array.isArray(auditResults)) return index;
  for (const entry of auditResults) {
    const showId = entry && entry.showId;
    if (!showId) continue;
    // Deliberately NOT every aggregator-listed URL — only the ones this show
    // is recorded as still MISSING. A cited URL we already hold for this show
    // needs no flag, and a cited URL that was never a gap is not evidence of
    // anything blocked. Scoping to `missing` targets exactly the deadlock:
    // the audit says "show B is missing this URL", the ownership guard says
    // "show A owns it and you may not create a second copy", and nothing can
    // move. Broadening this to aggregatorListedUrls newly flagged 297 corpus
    // files as isCombinedReview — which exempts them from the cross-show
    // contamination guards — to fix 2 genuinely-stuck ones. Not a trade worth
    // making silently.
    const urls = Array.isArray(entry.missing)
      ? entry.missing.map((m) => (m && typeof m === 'object' ? m.url : m))
      : [];
    for (const url of urls) {
      if (typeof url !== 'string') continue;
      const norm = normalizeUrl(url);
      if (!norm) continue;
      if (!index.has(norm)) index.set(norm, new Set());
      index.get(norm).add(showId);
    }
  }
  return index;
}

module.exports = { baseSlug, areSameTitleSiblings, computeCombinedWith, buildAggregatorCitationIndex };
