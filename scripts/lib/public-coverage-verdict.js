'use strict';

/**
 * BRO-2790: only publish an audited verdict when it covers the dated reviews
 * being emitted. A rebuild cannot refresh the census by changing its timestamp:
 * that requires another gap audit. Use the existing missing-cov fallback until
 * then, and report the stale row without blocking publication of new reviews.
 * Counts remain census candidate counts, not the length of the review list.
 */
function publicCoverageVerdict(cov, reviews, { showId, warn = console.warn } = {}) {
  if (!cov) return null;

  const computedAt = typeof cov.computedAt === 'string' ? Date.parse(cov.computedAt) : NaN;
  const dates = (reviews || []).map(r => typeof r?.d === 'string' ? Date.parse(r.d) : NaN)
    .filter(Number.isFinite);
  const latest = dates.length ? Math.max(...dates) : null;
  if (!Number.isFinite(computedAt) || (latest !== null && computedAt < latest)) {
    warn(`[coverage-verdict] ${showId || 'unknown show'}: omitting stale cov; computedAt=${cov.computedAt || 'missing'}, latestReview=${latest === null ? 'unknown' : new Date(latest).toISOString()}. Refresh the gap audit.`);
    return null;
  }
  return cov;
}

module.exports = { publicCoverageVerdict };
