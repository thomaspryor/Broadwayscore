/**
 * Critic Score tiers: the thresholds and the display labels, in one place.
 *
 * The market-aware Critical Gold threshold and the tier boundaries live ONLY
 * here. src/config/score-buckets.ts re-exports getGoldThreshold (which
 * ScoreBadge, ScoreBreakdownBar, the OG route etc. import) and builds
 * getScoreBucket on getScoreTierId, and scripts/generate-mobile-data.js writes
 * the app feed's `cr.l` with getScoreTierLabel. Before this module the feed had
 * its own copy that ignored the market (a West End 84 read "Critical Gold" in
 * the app, "Recommended" on the site), did not round (an 82.6 read
 * "Recommended" in the app, "Critical Gold" on the site) and still said
 * "Skippable" where the site says "Mixed".
 *
 * ScoreBadge.getScoreTier and getScoreTierRange (src/components/show-cards/ScoreBadge.tsx)
 * read these constants; tests/unit/mobile-feed-website-parity.test.ts fails if
 * getScoreTier and getScoreTierLabel ever disagree on any score or market.
 *
 * The social cards, review OG images, emails, newsletter, status page, brand
 * tokens and the site's score-tier filter all take their tiers from here too.
 * scripts/lib/score-tier-literals.test.mjs fails if a new copy appears: a Gold
 * literal 83 next to a tier label, or "Skippable" in code, anywhere in scripts/
 * or src/ outside this file and its listed exceptions.
 *
 * Keep this file pure (no fs, no path, no requires): it is bundled into client
 * components through score-buckets.ts, like scripts/lib/min-reviews.js.
 *
 * The 55-64 DATA label "Skippable" (src/config/scoring.ts getCriticLabel, the
 * fantasy points map) is a different thing and is not defined here; see
 * scripts/lib/score-tier-label-contract.test.mjs.
 */

/**
 * Critical Gold minimum per market. West End star ratings (5-point scale)
 * cluster at 80/100, so London Gold needs 85 against Broadway's 83.
 * @type {Record<string, number>}
 */
const MARKET_GOLD_THRESHOLD = {
  'west-end': 85,
  'off-west-end': 85,
};
const DEFAULT_GOLD_THRESHOLD = 83;

// Lower bounds of the tiers under Gold. They do not vary by market.
const RECOMMENDED_MIN = 75;
const WORTH_SEEING_MIN = 65;
const MIXED_MIN = 55;

/**
 * Display label per tier id (the ids are ScoreBucket ids in src/types/canonical).
 * Must equal SCORE_BUCKETS[].label in score-buckets.ts and SCORE_TIERS[].label
 * in ScoreBadge.tsx (pinned by the parity tests).
 */
const SCORE_TIER_LABELS = {
  'must-see': 'Critical Gold',
  recommended: 'Recommended',
  'worth-seeing': 'Worth Seeing',
  skippable: 'Mixed',
  'stay-away': 'Critical Miss',
};

/**
 * Critical Gold minimum score for a market.
 * @param {string} [category]
 * @returns {number}
 */
function getGoldThreshold(category) {
  return MARKET_GOLD_THRESHOLD[category || ''] ?? DEFAULT_GOLD_THRESHOLD;
}

/**
 * Tier id for a score, compared as given (no rounding). This is the
 * score-buckets.getScoreBucket rule.
 * @param {number} score
 * @param {string} [category]
 * @returns {'must-see' | 'recommended' | 'worth-seeing' | 'skippable' | 'stay-away'}
 */
function getScoreTierId(score, category) {
  if (score >= getGoldThreshold(category)) return 'must-see';
  if (score >= RECOMMENDED_MIN) return 'recommended';
  if (score >= WORTH_SEEING_MIN) return 'worth-seeing';
  if (score >= MIXED_MIN) return 'skippable';
  return 'stay-away';
}

/**
 * The label the website's score badge shows next to a Critic Score: the score
 * is rounded first, as the badge displays it (ScoreBadge.getScoreTier), so a
 * raw 82.6 shown as "83" is Critical Gold on Broadway.
 * @param {number | null | undefined} score
 * @param {string} [category]
 * @returns {string | null} null when there is no score
 */
function getScoreTierLabel(score, category) {
  if (score === null || score === undefined) return null;
  return SCORE_TIER_LABELS[getScoreTierId(Math.round(score), category)];
}

/**
 * Breakdown-bar tier for ONE review score (Rave / Positive / Mixed / Negative).
 * Rounds first, as the badge displays it. The cutoffs reuse the badge bands so
 * the bar never disagrees with the colors beside it: Rave = Critical Gold,
 * Positive = Recommended + Worth Seeing (green and blue badges), Mixed = the
 * orange badge band, Negative = red. Returns null for non-finite scores.
 * @param {number | null | undefined} score
 * @param {string} [category]
 * @returns {'rave' | 'positive' | 'mixed' | 'negative' | null}
 */
function getBreakdownTierId(score, category) {
  if (!Number.isFinite(score)) return null;
  const rounded = Math.round(score);
  if (rounded >= getGoldThreshold(category)) return 'rave';
  if (rounded >= WORTH_SEEING_MIN) return 'positive';
  if (rounded >= MIXED_MIN) return 'mixed';
  return 'negative';
}

module.exports = {
  MARKET_GOLD_THRESHOLD,
  DEFAULT_GOLD_THRESHOLD,
  RECOMMENDED_MIN,
  WORTH_SEEING_MIN,
  MIXED_MIN,
  SCORE_TIER_LABELS,
  getGoldThreshold,
  getScoreTierId,
  getScoreTierLabel,
  getBreakdownTierId,
};
