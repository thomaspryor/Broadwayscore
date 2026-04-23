/**
 * Multi-critic SERP helper.
 *
 * A single outlet+show SERP query returns only Google's top-ranked URL, so the
 * non-primary critic at a multi-critic outlet is silently dropped. The outlets
 * below publish multiple independent Broadway reviews per show often enough
 * that we pay per-critic SERP queries for them by default.
 */

const MULTI_CRITIC_SERP_OUTLETS = new Set([
  'nytimes',
  'vulture',
  'nystagereview',
  'theatrely',
]);

/**
 * Should SERP discovery issue one query per critic for this outlet?
 * @param {string} outletIdLower - outlet id in lowercase
 * @param {string[]} criticsArray - the outlet's critics list (from critic-outlets.json)
 * @returns {boolean}
 */
function shouldQueryPerCritic(outletIdLower, criticsArray) {
  if (!outletIdLower) return false;
  if (!Array.isArray(criticsArray) || criticsArray.length <= 1) return false;
  return MULTI_CRITIC_SERP_OUTLETS.has(outletIdLower);
}

/**
 * Normalize a critic name for coverage comparison — lowercase, strip
 * non-alphanumerics. Aggressive enough to match "Jesse Green" vs "jesse-green"
 * vs "Jesse  Green." Returns '' for falsy input so `coveredCritics.has('')`
 * never reports false coverage on nameless reviews.
 */
function normalizeCriticForCoverage(name) {
  if (!name) return '';
  const stripped = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!stripped || stripped === 'unknown') return '';
  return stripped;
}

/**
 * Given an outlet's critics list and the set of reviews already found for that
 * outlet (via aggregator), return the critics who are NOT yet represented.
 *
 * Aggregators often find 1 critic at a multi-critic outlet and skip the rest;
 * blanket-skipping SERP on `foundOutletIds` means the remaining critics are
 * never discovered. Call this to compute the critics still worth querying.
 *
 * @param {string[]} criticList - outlet.critics from critic-outlets.json
 * @param {Array<{criticName?: string}>} foundReviewsForOutlet - reviews where outletId matches
 * @returns {string[]} critics from criticList with no coverage yet
 */
function remainingCritics(criticList, foundReviewsForOutlet) {
  if (!Array.isArray(criticList)) return [];
  const covered = new Set();
  const reviews = Array.isArray(foundReviewsForOutlet) ? foundReviewsForOutlet : [];
  for (const r of reviews) {
    const n = normalizeCriticForCoverage(r && r.criticName);
    if (n) covered.add(n);
  }
  return criticList.filter(c => !covered.has(normalizeCriticForCoverage(c)));
}

/**
 * Normalize a URL for dedup comparison — lowercase, strip trailing slash,
 * drop hash fragments. Keeps query params (they sometimes distinguish
 * per-critic review pages at the same outlet).
 */
function normalizeUrlForDedup(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    let s = u.toString().toLowerCase();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return String(url).toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
  }
}

module.exports = {
  MULTI_CRITIC_SERP_OUTLETS,
  shouldQueryPerCritic,
  normalizeCriticForCoverage,
  remainingCritics,
  normalizeUrlForDedup,
};
