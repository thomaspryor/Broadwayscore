/**
 * Which discovered rows may mark an outlet as "found" for this cycle (BRO-6762 hole 1).
 *
 * Stagedoor archive rows carry no URL (the site's cards expose outlet, stars and an
 * excerpt only). processDiscoveredReviews skips url-less rows, so such a row never
 * becomes a review file. If it still marks its outlet as found, site search and SERP
 * skip that outlet for the cycle and the real review URL is never looked for; only
 * the after-the-fact gap audit finds it. A url-less row from a source that cannot
 * resolve a URL later therefore must not claim coverage.
 */
const URLLESS_NON_ACTIONABLE_SOURCES = new Set(['stagedoor']);

function claimsOutletCoverage(row, flaggedOnlyOutletIds) {
  if (!row || !row.outletId) return false;
  const hasUrl = typeof row.url === 'string' && row.url.trim() !== '';
  if (hasUrl) return true;
  // BRO-7293: an outlet whose only files on disk are flagged (an earlier production's
  // review) has no review of THIS production. A url-less roundup excerpt for it is not a
  // URL to collect, so it must not mark the outlet found and switch off site search and
  // SERP for the real review (Cititour, Here There Are Blueberries: missed overnight).
  if (flaggedOnlyOutletIds && flaggedOnlyOutletIds.has(String(row.outletId).toLowerCase())) return false;
  return !URLLESS_NON_ACTIONABLE_SOURCES.has(String(row.source || '').toLowerCase());
}

/** Add the outlet ids of rows that may claim coverage to `set` (lowercased). Returns set. */
function addClaimedOutletIds(set, rows, flaggedOnlyOutletIds) {
  for (const r of rows || []) {
    if (claimsOutletCoverage(r, flaggedOnlyOutletIds)) set.add(String(r.outletId).toLowerCase());
  }
  return set;
}

/**
 * Build the discovered-row shape for one Stagedoor archive card. The card has no
 * link, so the row carries `urlless: true`; downstream code must not treat it as
 * outlet coverage (see claimsOutletCoverage) and the audit/URL resolver may fill it.
 */
function buildStagedoorRow(r, { showId, outletId } = {}) {
  const row = {
    outlet: r.outlet || 'Unknown',
    outletId,
    criticName: 'Unknown', // Stagedoor doesn't provide critic names
    url: '',
    urlless: true,
    excerpt: r.excerpt || '',
    score: r.stars ? Math.round((r.stars / 5) * 100) : null,
    scoreSource: r.stars ? 'stagedoor-star-rating' : undefined,
    source: 'stagedoor',
  };
  if (showId) row.showId = showId;
  return row;
}

module.exports = { buildStagedoorRow, claimsOutletCoverage, addClaimedOutletIds, URLLESS_NON_ACTIONABLE_SOURCES };
