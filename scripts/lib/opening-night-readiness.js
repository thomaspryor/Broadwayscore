'use strict';

/**
 * opening-night-readiness — "is this show's T1/T2 coverage done?" predicates,
 * extracted from opening-night-poller.js (card #1413) so a caller that only
 * needs the answer to that question — the opening-night monitor launcher,
 * which runs unconditionally every 20 min for up to 31h — doesn't have to
 * require() poller.js's ~45-line dependency block (gather-reviews,
 * site-search-discovery, llm-extractor, scrapers, discord-notify, ...), which
 * exists to DO discovery, not just report on it. Same extraction rationale as
 * opening-night-windows.js's own header comment (CLAUDE.md §15).
 *
 * opening-night-poller.js re-exports these (it's still the call site every
 * existing consumer — opening-night-status.js, generate-status-page.js —
 * imports from) so there is exactly one implementation.
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./venue-classification');
const { getFoundOutletIds } = require('./found-outlet-ids');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');

/** MIN_REVIEWS/MIN_T1_REVIEWS/MIN_T2_REVIEWS/MIN_HIGH_CONFIDENCE broadcast-readiness thresholds for a market. */
function getThresholds(market) {
  const isWE = market === 'west-end' || market === 'off-west-end';
  return {
    MIN_REVIEWS: isWE ? 8 : 12,
    MIN_T1_REVIEWS: 3,
    MIN_T2_REVIEWS: isWE ? 2 : 3,
    MIN_HIGH_CONFIDENCE: isWE ? 6 : 8,
  };
}

/**
 * Get T1/T2 outlets that haven't been found yet for a show.
 * v5 (2026-04-29): use region-aware getTier() so per-region tiers from
 * outlet-tiers.json (e.g. NYT T2 in London, The Stage T1 in London) override
 * the registry's plain `tier` field. Without this, opening-night discovery
 * would treat NYT as T1 for West End shows even though it's effectively T2
 * cross-coverage.
 */
function getMissingT1T2Outlets(showId, market, show) {
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const foundIds = getFoundOutletIds(showId, { show, market });

  // Lazy require (matches the original poller.js placement): keeps this
  // module's own require-time footprint minimal so a broken outlet-tiers.js
  // fails inside the function call, not at require() of this whole file —
  // same failure-isolation the original code had.
  const { getTier } = require('./outlet-tiers');
  const showCategory = isLondonMarket(market) ? 'west-end' : 'broadway';

  const missing = [];
  for (const [outletId, outlet] of Object.entries(outlets)) {
    const effectiveTier = getTier(outletId, { showCategory });
    if (effectiveTier > 2) continue;
    if (foundIds.has(outletId.toLowerCase())) continue;
    if (isLondonMarket(market) && !outlet.isDualMarket && outlet.region !== 'uk') continue;
    if (market === 'broadway' && outlet.region === 'uk' && !outlet.isDualMarket) continue;
    missing.push({ id: outletId, name: outlet.displayName || outletId, tier: effectiveTier, domain: outlet.domain, isDualMarket: !!outlet.isDualMarket });
  }

  return missing.sort((a, b) => a.tier - b.tier); // T1 first
}

/** Check readiness for broadcast. */
function checkReadiness(showId, market = 'broadway') {
  const { MIN_REVIEWS, MIN_T1_REVIEWS, MIN_T2_REVIEWS, MIN_HIGH_CONFIDENCE } = getThresholds(market);
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const arr = Array.isArray(reviews.reviews || reviews) ? (reviews.reviews || reviews) : Object.values(reviews.reviews || reviews);

  const showRevs = arr.filter(r => r.showId === showId && r.assignedScore > 0);
  const t1 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 1; }).length;
  const t2 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 2; }).length;
  const hiConf = showRevs.filter(r => r.scoreConfidence === 'high' || r.scoreConfidence === 'medium').length;

  return {
    total: showRevs.length,
    t1,
    t2,
    highConfidence: hiConf,
    ready: showRevs.length >= MIN_REVIEWS && t1 >= MIN_T1_REVIEWS && t2 >= MIN_T2_REVIEWS && hiConf >= MIN_HIGH_CONFIDENCE,
    reasons: [
      showRevs.length < MIN_REVIEWS ? `${showRevs.length}/${MIN_REVIEWS} total` : null,
      t1 < MIN_T1_REVIEWS ? `T1:${t1}/${MIN_T1_REVIEWS}` : null,
      t2 < MIN_T2_REVIEWS ? `T2:${t2}/${MIN_T2_REVIEWS}` : null,
      hiConf < MIN_HIGH_CONFIDENCE ? `hi-conf:${hiConf}/${MIN_HIGH_CONFIDENCE}` : null,
    ].filter(Boolean),
  };
}

/**
 * A show's T1/T2 coverage is "done" for the monitor's purposes: every T1/T2
 * outlet has a discovered file AND enough of them are scored to clear the
 * existing broadcast-readiness bar. Missing-outlets alone isn't enough (a
 * discovered-but-unscored T1 file is exactly the class task #1328 found —
 * "found" means a file exists, not that it reached the composite), so both
 * halves are required.
 */
function isShowCoverageComplete(showId, market, show) {
  const missing = getMissingT1T2Outlets(showId, market, show);
  if (missing.length > 0) return false;
  return checkReadiness(showId, market).ready;
}

module.exports = { getThresholds, getMissingT1T2Outlets, checkReadiness, isShowCoverageComplete };
