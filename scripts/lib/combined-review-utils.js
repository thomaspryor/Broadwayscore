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

const JOINT_REVIEW_MIN_TEXT = 500;

/**
 * Should flag-combined-reviews.js clear a wrong_show rejection as joint coverage?
 * URL co-occurrence alone was trusted, so a review of another show filed under
 * two dirs got its wrongShow flag overridden (BRO-4599: an NYT Monte Cristo
 * review under Becky Shaw, a Times Christmas Carol Goes Wrong review under The
 * Play That Goes Wrong). Now refused when a human-approved fix set the flag, or
 * when a substantive body never names this show. Short bodies keep the old
 * behaviour: there is too little text to judge.
 *
 * @param {object} data review record
 * @param {string|null} showTitle title of the dir the record is filed under
 * @returns {boolean}
 */
function shouldRecoverJointWrongShow(data, showTitle) {
  if (!data || data.wrongShow !== true || data.rejectionReason !== 'wrong_show') return false;
  const { hasApprovedFlag } = require('./approved-fix-flag');
  if (hasApprovedFlag(data, 'wrongShow')) return false;
  const text = typeof data.fullText === 'string' ? data.fullText : '';
  if (showTitle && text.length >= JOINT_REVIEW_MIN_TEXT) {
    const { textMentionsTitle } = require('./show-title-variants');
    if (!textMentionsTitle(text, showTitle)) return false;
  }
  return true;
}

/**
 * URL key used to decide that two shows' files are the SAME article.
 *
 * Tracking params and fragments are dropped, but a query that IS the article id
 * is kept: Lighting & Sound America serves every story as /news/story.asp?ID=N,
 * and stripping "?ID=N" collapsed all of them into one key, so
 * lighting-and-sound-america--david-barbour.json ended up with combinedWith
 * listing ~400 shows (BRO-6670 #27, BRO-6682).
 */
const ARTICLE_ID_PARAMS = ['id', 'p', 'page_id', 'story', 'storyid', 'story_id', 'article', 'articleid', 'article_id', 'post', 'nid'];
function normalizeArticleUrl(url) {
  if (!url) return null;
  const base = String(url).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/#.*$/, '');
  const qi = base.indexOf('?');
  let pathPart = (qi === -1 ? base : base.slice(0, qi)).replace(/\/$/, '').toLowerCase();
  if (qi !== -1) {
    const params = new URLSearchParams(base.slice(qi + 1));
    const kept = [];
    for (const [k, v] of params) {
      if (ARTICLE_ID_PARAMS.includes(k.toLowerCase()) && v) kept.push(`${k.toLowerCase()}=${v.toLowerCase()}`);
    }
    if (kept.length) pathPart += '?' + kept.sort().join('&');
  }
  return pathPart || null;
}

/**
 * A combinedWith list this long is not a joint review: the file was grouped by a
 * collapsed URL key (LSA story.asp, ~400 shows). flag-combined-reviews clears
 * the flag when the corrected key no longer groups the file with 2+ shows.
 */
const MAX_PLAUSIBLE_COMBINED_SHOWS = 10;
function isBogusCombinedFlag(data) {
  return !!data && data.isCombinedReview === true && Array.isArray(data.combinedWith)
    && data.combinedWith.length > MAX_PLAUSIBLE_COMBINED_SHOWS;
}

module.exports = { isBogusCombinedFlag, MAX_PLAUSIBLE_COMBINED_SHOWS, normalizeArticleUrl, baseSlug, areSameTitleSiblings, computeCombinedWith, shouldRecoverJointWrongShow };
