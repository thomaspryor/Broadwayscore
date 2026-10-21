'use strict';

const { isRecentlyLive } = require('./show-liveness');

/**
 * Pure predicates for the opening-night metadata completeness gate (card #189).
 * Catches empty cast / placeholder synopsis / stale "upcoming" tag on shows
 * that are open or about to open — the class of bug that shipped The Whoopi
 * Monologues live with cast:[] and a templated synopsis.
 */

// Phrases the LLM synopsis generator tends to fall back on when it lacks
// specific plot detail. Anchored loosely enough to catch minor rewording but
// specific enough to avoid matching real synopses (e.g. "brings back memories").
const PLACEHOLDER_SYNOPSIS_PATTERNS = [
  /special theatrical experience/i,
  /brings back characters/i,
];

const MIN_SYNOPSIS_LENGTH = 120;

// Liveness for the stale-'upcoming'-tag check: status=open ONLY. Reproduces
// the historical `STALE_UPCOMING_STATUSES = new Set(['open'])` by
// construction — a previews show may legitimately still carry the tag, and a
// closed show's tags are nobody's concern (audit S7-T7;
// tests/unit/show-liveness.test.mjs pins the equivalence).
const STALE_UPCOMING_LIVENESS = Object.freeze({ liveStatuses: Object.freeze(['open']), allowClosed: false });

/**
 * @param {Object} show
 * @returns {boolean} true if cast is missing or empty
 */
function hasEmptyCast(show) {
  if (!show || !Array.isArray(show.cast)) return true;
  return show.cast.length === 0;
}

/**
 * @param {string|null|undefined} synopsis
 * @returns {boolean} true if synopsis looks empty, templated, or too thin to be useful
 */
function isPlaceholderSynopsis(synopsis) {
  const text = (synopsis || '').trim();
  if (!text) return true;
  if (PLACEHOLDER_SYNOPSIS_PATTERNS.some(re => re.test(text))) return true;
  return text.length < MIN_SYNOPSIS_LENGTH;
}

/**
 * @param {Object} show
 * @returns {boolean} true if the show is live (status=open) but still tagged 'upcoming'
 */
function hasStaleUpcomingTag(show) {
  if (!show || !Array.isArray(show.tags)) return false;
  return isRecentlyLive(show, STALE_UPCOMING_LIVENESS) && show.tags.includes('upcoming');
}

// Statuses that mean the show is no longer "upcoming" (BRO-3208). The tag is a
// write-time snapshot stamped by discovery; nothing on a status transition
// removed it, so 300+ open/previews/closed shows kept it and the compare page
// rendered "upcoming" as a genre. Broader than hasStaleUpcomingTag above, which
// stays open-and-recent because it feeds per-show opening-night alerts.
const PAST_UPCOMING_STATUSES = Object.freeze(['open', 'previews', 'closed']);

/**
 * @param {Object} show
 * @returns {boolean} true if the stored tags still say 'upcoming' (any case)
 *   while the status has moved past upcoming/announced
 */
function hasStoredStaleUpcomingTag(show) {
  if (!show || !Array.isArray(show.tags)) return false;
  if (!PAST_UPCOMING_STATUSES.includes(show.status)) return false;
  return show.tags.some(isUpcomingTag);
}

/**
 * The one tag matcher for 'upcoming' (any case). Shared by the fixer,
 * validate-data's status flips and generate-mobile-data so they never drift.
 * @param {unknown} tag
 * @returns {boolean}
 */
function isUpcomingTag(tag) {
  return typeof tag === 'string' && tag.toLowerCase() === 'upcoming';
}

/**
 * Removes every 'upcoming' tag (any case) from show.tags in place. Call it on
 * any write that moves a show into PAST_UPCOMING_STATUSES.
 * @param {Object} show
 * @returns {boolean} true if a tag was removed
 */
function stripUpcomingTag(show) {
  if (!show || !Array.isArray(show.tags) || !show.tags.some(isUpcomingTag)) return false;
  show.tags = show.tags.filter(t => !isUpcomingTag(t));
  return true;
}

/**
 * Market-aware canonical-title match: true only if another show shares the
 * same canonical title AND the same category. A same-title show in a DIFFERENT
 * category (e.g. hamilton-2015 [broadway] vs hamilton-west-end-2021 [west-end],
 * or oh-mary-2024 [broadway] vs oh-mary-off-broadway-2024 [off-broadway]) is a
 * transfer of the same production, not a revival — isRevivalByCanonicalTitle
 * (review-guards.js) doesn't distinguish these, so long-runners like Wicked/
 * Hamilton/Hadestown/Oh Mary!/Lion King/Book of Mormon would false-positive if
 * used directly. Uses `category` (broadway/off-broadway/west-end/off-west-end)
 * rather than the coarser `market` (broadway/west-end only — off-Broadway
 * shows carry market='broadway'), falling back to `market` if category absent.
 * @param {Object} show
 * @param {Array} shows
 * @returns {boolean}
 */
function isTourShow(show) {
  return !!show && (!!show.tourOf || show.category === 'tour' || show.market === 'tour');
}

function hasSameMarketTitleMatch(show, shows) {
  if (!show || !Array.isArray(shows)) return false;
  const targetTitle = (show.canonicalTitle || show.title || '').toLowerCase().trim();
  if (!targetTitle) return false;
  // A tour is the same production on the road, never a revival of its parent
  // or of a sibling tour segment (BRO-5439).
  if (isTourShow(show)) return false;
  const targetMarket = show.category || show.market || null;
  const startOf = x => x.openingDate || x.previewsStartDate || null;
  return shows.some(s => {
    if (!s || s.id === show.id) return false;
    const t = (s.canonicalTitle || s.title || '').toLowerCase().trim();
    if (t !== targetTitle) return false;
    if ((s.category || s.market || null) !== targetMarket) return false;
    // Only an EARLIER production makes `show` a revival. A later sibling
    // (e.g. sacrilegious-2027 flagged isRevival, BRO-5439) is the revival;
    // this show is the original.
    const a = startOf(s);
    const b = startOf(show);
    if (a && b) return a <= b;
    if (a && !b) return true; // undated target: a dated sibling is presumably earlier
    return s.isRevival !== true; // undated sibling: a flagged revival is the later one
  });
}

/**
 * Count standalone occurrences of "revival" across a set of texts (e.g. review
 * fullText bodies). Used as a secondary signal alongside hasSameMarketTitleMatch
 * for shows where a canonical-title match isn't available (retitled revivals).
 * @param {Array<string>} texts
 * @returns {number}
 */
function countRevivalMentions(texts) {
  const re = /\brevival\b/gi;
  let count = 0;
  for (const t of texts || []) {
    if (!t) continue;
    const matches = t.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

module.exports = {
  PLACEHOLDER_SYNOPSIS_PATTERNS,
  MIN_SYNOPSIS_LENGTH,
  STALE_UPCOMING_LIVENESS,
  hasEmptyCast,
  isPlaceholderSynopsis,
  hasStaleUpcomingTag,
  PAST_UPCOMING_STATUSES,
  hasStoredStaleUpcomingTag,
  isUpcomingTag,
  stripUpcomingTag,
  hasSameMarketTitleMatch,
  isTourShow,
  countRevivalMentions,
};
