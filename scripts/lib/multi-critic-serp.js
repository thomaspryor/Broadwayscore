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

module.exports = {
  MULTI_CRITIC_SERP_OUTLETS,
  shouldQueryPerCritic,
};
