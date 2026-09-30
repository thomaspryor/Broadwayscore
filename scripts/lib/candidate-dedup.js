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
const { titlesMatch } = require('./title-normalization');
const { isSubtitleVariantOf, isColonSegmentVariant, levenshteinDistance, venuesMatch } = require('./deduplication');

const DEFAULT_DEDUP_JACCARD_THRESHOLD = 0.80;
const DEFAULT_TYPO_EDIT_DISTANCE_MAX = 3;
const DEFAULT_TYPO_MIN_TITLE_LENGTH = 10;

// BRO-4204 S4-T9 — the London pool. West End rows are frequently keyed on a
// venue string the aggregator slug can never reproduce: shows.json holds
// "Noël Coward Theatre" / "Dorfman Theatre" / "The Old Vic" where LBO's slug
// yields "noel coward" / "national" / "duke of york's". venuesMatch() (via
// normalizeVenueName) neither folds diacritics nor knows the National's
// auditoria, so the venue-gated pass above returned null for
// dracula-west-end-2025, pride-west-end-2026, cyrano-de-bergerac-west-end-
// 2026, … and the promoter minted a same-title duplicate that validate-data
// then refused — sinking the whole batch (data/audit/we-promotion-log.jsonl:
// 116 skip-id-collision rows are the near-misses the id check alone caught).
// Within this pool a same-title row is treated as the SAME production
// (conservative: a genuinely new revival at a different venue is held for a
// human, which is this promoter's stated posture for anything uncertain).
// Gated on BOTH sides carrying a London category so the OB promoter — whose
// existing rows carry no category — keeps its "same title, different venue
// = different production" semantics untouched.
const LONDON_POOL_CATEGORIES = new Set(['west-end', 'off-west-end']);
function inLondonPool(row) {
  return !!(row && LONDON_POOL_CATEGORIES.has(row.category));
}

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
 * @param {(a: string, b: string) => boolean} [opts.venuePredicate=venuesMatch]
 *   venue equality test. promote-ob-venue-candidates.js passes a looser one
 *   (ob-cross-validation.js venuesCompatible) as a SECOND pass so a room
 *   suffix ("Soho Playhouse Main Stage") still reads as the same house
 *   (BRO-4396); a looser predicate only ever finds more duplicates.
 * @param {boolean} [opts.londonPoolFallback=true] when the venue strings do
 *   not match, fall back to a normalized-title match against rows in the
 *   London pool (both sides category west-end / off-west-end). See
 *   LONDON_POOL_CATEGORIES.
 */
function findExistingMatch(candidate, existingShows, opts = {}) {
  const jaccardThreshold = opts.jaccardThreshold ?? DEFAULT_DEDUP_JACCARD_THRESHOLD;
  const typoEditDistanceMax = opts.typoEditDistanceMax ?? DEFAULT_TYPO_EDIT_DISTANCE_MAX;
  const typoMinTitleLength = opts.typoMinTitleLength ?? DEFAULT_TYPO_MIN_TITLE_LENGTH;
  const londonPoolFallback = opts.londonPoolFallback ?? true;

  const all = Array.isArray(existingShows) ? existingShows : [];
  const venuePredicate = opts.venuePredicate || venuesMatch;
  const cands = all.filter(e => venuePredicate(candidate.venue, e.venue));
  const venueMatched = findExistingMatchAtVenue(candidate, cands, { jaccardThreshold, typoEditDistanceMax, typoMinTitleLength });
  if (venueMatched) return venueMatched;
  if (!londonPoolFallback || !inLondonPool(candidate)) return null;
  return findExistingMatchInLondonPool(candidate, all, cands);
}

/**
 * Venue-string fallback (BRO-4204 S4-T9): a London-pool candidate whose
 * venue string did not match any existing row is still "existing" when its
 * normalized title equals — or, per title-normalization.js's titlesMatch,
 * is a venue/format-suffix variant of — a London-pool row's title. Exact
 * normalized equality (title-match.js normalizeTitle, which folds
 * diacritics) is checked first so the reason string names the tighter
 * match. Rows the venue pass already evaluated are skipped.
 */
function findExistingMatchInLondonPool(candidate, existingShows, alreadyEvaluated = []) {
  const cNorm = normalizeTitle(candidate.title);
  if (!cNorm) return null;
  const seen = new Set(alreadyEvaluated);
  const pool = existingShows.filter(e => inLondonPool(e) && !seen.has(e));
  for (const e of pool) {
    if (normalizeTitle(e.title) === cNorm) {
      return { match: e, reason: `london-pool-title-equal (venue "${candidate.venue}" vs "${e.venue}")` };
    }
  }
  for (const e of pool) {
    if (candidate.title && e.title && titlesMatch(candidate.title, e.title)) {
      return { match: e, reason: `london-pool-title-variant-of: "${e.title}" (venue "${candidate.venue}" vs "${e.venue}")` };
    }
  }
  return null;
}

function findExistingMatchAtVenue(candidate, cands, { jaccardThreshold, typoEditDistanceMax, typoMinTitleLength }) {
  if (cands.length === 0) return null;
  const cNorm = normalizeTitle(candidate.title);
  const cTokens = titleTokens(candidate.title);
  for (const e of cands) {
    const eNorm = normalizeTitle(e.title);
    if (eNorm === cNorm) return { match: e, reason: 'normalized-equal' };
    if (isSubtitleVariantOf(candidate.title, e.title)) {
      return { match: e, reason: `subtitle-variant-of: "${e.title}"` };
    }
    // Performer-prefixed or subtitled listing of the same show at the same
    // venue: "Louis Katz: Conflicted" (TodayTix) vs "Conflicted" (venue page).
    // isSubtitleVariantOf only covers the pre-colon half; checkForDuplicate's
    // Check 7b already used this, but this path did not (2026-09-28 dup).
    if (isColonSegmentVariant(candidate.title, e.title)) {
      return { match: e, reason: `colon-segment-of: "${e.title}"` };
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
  findExistingMatchInLondonPool,
  LONDON_POOL_CATEGORIES,
  DEDUP_JACCARD_THRESHOLD: DEFAULT_DEDUP_JACCARD_THRESHOLD,
  TYPO_EDIT_DISTANCE_MAX: DEFAULT_TYPO_EDIT_DISTANCE_MAX,
  TYPO_MIN_TITLE_LENGTH: DEFAULT_TYPO_MIN_TITLE_LENGTH,
};
