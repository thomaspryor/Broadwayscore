/**
 * Cross-source candidate dedup, shared by every aggregator-roundup promotion
 * script (OB: promote-ob-venue-candidates.js; WE: promote-we-aggregator-candidates.js).
 *
 * Extracted verbatim from promote-ob-venue-candidates.js's findExistingMatch
 * (2026-08-14, task #1466) so the West End backstop reuses the exact same
 * venue+title matching instead of re-deriving it (CLAUDE.md §15 — the OB
 * version already absorbed several hard-won near-miss fixes documented below;
 * duplicating it would silently drop those fixes for the WE path).
 *
 * Thresholds are parameterizable (options) but default to the values the OB
 * script has run in production with:
 *   - DEDUP_JACCARD_THRESHOLD = 0.80 (not 0.85) because normalizeTitle's
 *     trailing-"musical" strip can unbalance token sets — "Heated Rivalry:
 *     The Unauthorized Musical Parody" keeps "musical" + "parody" but
 *     "...PARODY MUSICAL" loses trailing "musical" → jaccard 0.8, not 1.0.
 *   - TYPO_EDIT_DISTANCE_MAX = 3, TYPO_MIN_TITLE_LENGTH = 10: catches
 *     small-edit-distance near-misses ("Rosie O'Donnell's COMMON KNOWLEDGE"
 *     vs "Rosie O'Donnell: Common Knowledge") without false-colliding short
 *     titles ("Cats" vs "Rats", distance 1).
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');
const { isSubtitleVariantOf, levenshteinDistance, venuesMatch } = require('./deduplication');

const DEFAULT_DEDUP_JACCARD_THRESHOLD = 0.80;
const DEFAULT_TYPO_EDIT_DISTANCE_MAX = 3;
const DEFAULT_TYPO_MIN_TITLE_LENGTH = 10;

/**
 * Does `candidate` ({title, venue}) match an existing show ({id, title,
 * venue})? Same venue (per venuesMatch — see below) AND (normalized title OR
 * subtitle-stripped title OR small edit-distance typo OR jaccard ≥
 * threshold). Returns { match, reason } or null.
 *
 * Venue equality uses deduplication.js's venuesMatch(), NOT title-match.js's
 * canonicalVenue() directly — canonicalVenue falls back to the lowercased
 * FIRST WORD for any venue outside the curated VENUE_ALIASES table, so two
 * unrelated theatres that both start with "The" would collapse to the same
 * key. This function runs on every scheduled CI aggregator-roundup
 * promotion with no human in the loop (BRO-243, generalizing the fix task
 * #1246 shipped locally in aggregator-candidate-extract.js) — a false venue
 * MATCH here would silently skip a genuinely new show as an "existing"
 * duplicate.
 *
 * @param {{title: string, venue: string}} candidate
 * @param {Array<{id: string, title: string, venue: string}>} existingShows
 * @param {object} [opts]
 * @param {number} [opts.jaccardThreshold]
 * @param {number} [opts.typoEditDistanceMax]
 * @param {number} [opts.typoMinTitleLength]
 */
function findExistingMatch(candidate, existingShows, opts = {}) {
  const jaccardThreshold = opts.jaccardThreshold ?? DEFAULT_DEDUP_JACCARD_THRESHOLD;
  const typoEditDistanceMax = opts.typoEditDistanceMax ?? DEFAULT_TYPO_EDIT_DISTANCE_MAX;
  const typoMinTitleLength = opts.typoMinTitleLength ?? DEFAULT_TYPO_MIN_TITLE_LENGTH;

  const cands = (Array.isArray(existingShows) ? existingShows : [])
    .filter(e => venuesMatch(candidate.venue, e.venue));
  if (cands.length === 0) return null;
  const cNorm = normalizeTitle(candidate.title);
  const cTokens = titleTokens(candidate.title);
  for (const e of cands) {
    const eNorm = normalizeTitle(e.title);
    if (eNorm === cNorm) return { match: e, reason: 'normalized-equal' };
    if (isSubtitleVariantOf(candidate.title, e.title)) {
      return { match: e, reason: `subtitle-variant-of: "${e.title}"` };
    }
    if (cNorm.length >= typoMinTitleLength && eNorm.length >= typoMinTitleLength) {
      const dist = levenshteinDistance(cNorm, eNorm);
      if (dist >= 1 && dist <= typoEditDistanceMax) {
        return { match: e, reason: `typo-distance=${dist}-of: "${e.title}"` };
      }
    }
    const eTokens = titleTokens(e.title);
    if (cTokens.size > 0 && eTokens.size > 0) {
      const sim = jaccard(cTokens, eTokens);
      if (sim >= jaccardThreshold) return { match: e, reason: `jaccard=${sim.toFixed(2)}` };
    }
  }
  return null;
}

module.exports = {
  findExistingMatch,
  DEDUP_JACCARD_THRESHOLD: DEFAULT_DEDUP_JACCARD_THRESHOLD,
  TYPO_EDIT_DISTANCE_MAX: DEFAULT_TYPO_EDIT_DISTANCE_MAX,
  TYPO_MIN_TITLE_LENGTH: DEFAULT_TYPO_MIN_TITLE_LENGTH,
};
