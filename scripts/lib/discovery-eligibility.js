/**
 * Batch discovery eligibility for scrape-playbill-verdict.js,
 * scrape-nyc-theatre-roundups.js, and scrape-bww-reviews.js.
 *
 * All three exclude closed shows from weekly Google-fallback discovery
 * ("won't get new reviews"). Regional productions are short limited runs
 * that often close before weekly batch discovery ever reaches them, so a
 * flat category==='regional' carve-out was added to give them a shot after
 * closing (task/card 1632). Adversarial ship-check review flagged that an
 * unbounded carve-out lets a closed regional show retry forever — none of
 * the three scripts persist a negative/miss cache, so a show with no
 * discoverable page keeps burning a SERP call every week indefinitely.
 * Bound the exception to a window after closing so old, already-exhausted
 * misses age out like everything else.
 */

const REGIONAL_RETRY_WINDOW_DAYS = 90;

function isClosedShowEligibleForBatchDiscovery(show, now = Date.now()) {
  if (!show || show.status !== 'closed') return true;
  if (show.category !== 'regional') return false;
  if (!show.closingDate) return true; // no closing date on record — treat as recent, give it a shot
  const closingMs = new Date(show.closingDate).getTime();
  if (Number.isNaN(closingMs)) return true;
  const daysSinceClose = (now - closingMs) / (1000 * 60 * 60 * 24);
  return daysSinceClose <= REGIONAL_RETRY_WINDOW_DAYS;
}

/**
 * BRO-7213: order a batch-discovery list newest opening first (stable for ties,
 * undated shows last). The NYC Theatre and Playbill Verdict scrapers walk ~650-750
 * shows one SERP call at a time; under a --time-budget-min cap the shows left
 * unsearched should be the oldest, whose round-ups were found long ago or never
 * existed, not the new openings that can still gain one.
 */
function newestOpeningFirst(shows) {
  const key = (s) => (s && typeof s.openingDate === 'string' ? s.openingDate : '');
  return (shows || [])
    .map((s, i) => [s, i])
    .sort(([a, ia], [b, ib]) => {
      const ka = key(a); const kb = key(b);
      if (ka !== kb) return ka < kb ? 1 : -1;
      return ia - ib;
    })
    .map(([s]) => s);
}

module.exports = { isClosedShowEligibleForBatchDiscovery, newestOpeningFirst, REGIONAL_RETRY_WINDOW_DAYS };
