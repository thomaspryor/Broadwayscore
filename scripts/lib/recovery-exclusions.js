'use strict';

const { parseDate } = require('./date-utils');
const { outletIsUkMarketRegion, evaluateReverseLondonCrossMarketGuard } = require('./cross-market-guard');
const { laneBypasses } = require('./opening-night-lane/trust-model');

// Rebuild accepts relative BWW article links, but drops other relative paths
// (including author profiles). Keep normalization and exclusion together.
function resolveRelativeReviewUrl(url) {
  if (!url || url.startsWith('http://') || url.startsWith('https://')) return { url, exclude: false };
  if (/^\/([-a-z]+)\/article\//.test(url)) {
    return { url: `https://www.broadwayworld.com${url}`, exclude: false };
  }
  return { url, exclude: true };
}

// Extracted from rebuild-all-reviews.js. A production manual clear does not
// bypass this independent market gate; allowCrossMarket does.
function reverseCrossMarketExclusion({ data, show, canonicalOutlet, rawOutlet, outletRegionMap, dualMarketOutlets }) {
  if (!show || !['broadway', 'off-broadway'].includes(show.category || 'broadway')
      || data.allowEarlyDate || data.allowCrossMarket
      || laneBypasses(data, 'tourCrossMarket', { openingDate: show.openingDate })
      || dualMarketOutlets.has(canonicalOutlet) || dualMarketOutlets.has(rawOutlet)) {
    return { exclude: false };
  }
  const region = outletRegionMap[canonicalOutlet] || outletRegionMap[rawOutlet];
  let ukHost = false;
  try {
    const hostname = new URL(data.url).hostname;
    ukHost = hostname.endsWith('.co.uk') || hostname.endsWith('.org.uk');
  } catch { /* malformed URLs have no host evidence */ }
  const urlIsUK = !region && ukHost;
  if (!outletIsUkMarketRegion(outletRegionMap, canonicalOutlet, rawOutlet) && !urlIsUK) {
    return { exclude: false };
  }
  const priorRun = evaluateReverseLondonCrossMarketGuard({
    outletIsLondon: true,
    reviewDate: data.publishDate ? parseDate(data.publishDate) : null,
    priorRuns: show.priorRuns,
  });
  const cv = data.contentVerification;
  const cvSaysCorrect = cv && cv.isValid === true && cv.wrongProduction === false
    && cv.confidence === 'high' && !ukHost;
  return { exclude: !cvSaysCorrect && priorRun.shouldFlag, urlIsUK };
}

// The verifier's includable list drives BOTH the scoring and rebuild checks.
// Use the real rebuild gates in addition to the canonical per-file predicate.
function explainRecoveryExclusion(data, show, filePath, marketContext) {
  const { explainExclusion } = require('./review-guards');
  const reason = explainExclusion(data, show, filePath);
  if (reason) return reason;
  if (resolveRelativeReviewUrl(data.url).exclude) return 'invalidUrl';
  const { normalizeOutlet } = require('./review-normalization');
  const rawOutlet = (data.outletId || data.outlet || '').toLowerCase();
  if (reverseCrossMarketExclusion({
    data, show, rawOutlet, canonicalOutlet: normalizeOutlet(rawOutlet), ...marketContext,
  }).exclude) return 'crossMarket';
  return null;
}

module.exports = { resolveRelativeReviewUrl, reverseCrossMarketExclusion, explainRecoveryExclusion };
