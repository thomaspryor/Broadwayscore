'use strict';

/**
 * Rows written only by the legacy LLM 'web-search' discovery step (BRO-5081).
 *
 * That step made up the row by itself: no aggregator or page ever vouched for
 * it, so its url, byline and excerpt fields (dtliExcerpt and friends) are the
 * step's own guesses. 0 of 34 reachable review pages contained the excerpt.
 * Pure, no I/O.
 */
function isLegacyWebSearchOnly(data) {
  if (!data) return false;
  const sources = [].concat(data.sources || [], data.source || []).filter((x) => typeof x === 'string' && x);
  return sources.length > 0 && sources.every((x) => x === 'web-search');
}

module.exports = { isLegacyWebSearchOnly };
