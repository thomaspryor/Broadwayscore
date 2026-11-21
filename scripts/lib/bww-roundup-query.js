/**
 * Search query for a show's BroadwayWorld review roundup (BRO-6101).
 *
 * The per-show query used `site:broadwayworld.com/article ... broadway`. BWW
 * files London roundups under /westend/article/ (e.g. .../westend/article/
 * Review-Roundup-BEAUTIFUL-LITTLE-FOOL-at-Southwark-Playhouse-20260123), which
 * a `/article` path filter excludes, so those shows came back "[MISS] no URL
 * slug matches" even when the roundup existed. London titles therefore search
 * the whole site and drop the "broadway" keyword.
 */

function buildRoundupQuery({ searchTitle, year, isOpera = false, isLondon = false }) {
  if (isOpera) return `site:broadwayworld.com "${searchTitle}" review ${year}`;
  if (isLondon) return `site:broadwayworld.com "Review Roundup" "${searchTitle}" ${year}`.trim();
  return `site:broadwayworld.com/article "Review Roundup" "${searchTitle}" broadway ${year}`;
}

module.exports = { buildRoundupQuery };
