'use strict';

/**
 * tier-attempt-stats.js — per-domain tier tallies for regenerate-tier-configs.js
 * (BRO-4334: partial text counts as a failure for ordering).
 *
 * The collector's tier loop used to accept the first non-garbage result, so a
 * tier that returned only page one of a hard-paywall review (ScrapingBee on
 * NYT) was logged `success: true` and the weekly regenerate job kept ranking
 * it first. Now:
 *   - new fetchAttempts mark such results `{ success: false, partial: true }`;
 *   - older files are corrected retroactively: when a file ended up
 *     contentTier 'truncated' and its winning attempt (the last `success:true`
 *     entry — the loop returns on the first accepted tier) is the method that
 *     produced the stored text, that attempt is tallied as partial.
 * Partial = failure for ORDERING, but success for the dead-end SKIP list —
 * a tier that only ever yields partial text is still the last-resort fallback.
 */

function emptyBucket() {
  return { successes: 0, failures: 0, partials: 0 };
}

/**
 * Index of the attempt that produced the stored text, or -1.
 * @param {object} data review-text file
 */
function winningAttemptIndex(data) {
  const attempts = Array.isArray(data && data.fetchAttempts) ? data.fetchAttempts : [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i] && attempts[i].success) return i;
  }
  return -1;
}

/**
 * Add one review file's fetchAttempts into `stats[domain][tierId]`.
 *
 * @param {object} stats  { [domain]: { [tierId]: {successes, failures, partials} } } (mutated)
 * @param {string} domain
 * @param {object} data   parsed review-text file
 * @param {(method: string, tier: number) => string} normalizeTierId
 * @returns {boolean} true when the file had attempts to tally
 */
function tallyFileAttempts(stats, domain, data, normalizeTierId) {
  const attempts = Array.isArray(data && data.fetchAttempts) ? data.fetchAttempts : [];
  if (!domain || attempts.length === 0) return false;

  const winner = winningAttemptIndex(data);
  const retroPartial = winner >= 0
    && data.contentTier === 'truncated'
    && !!data.fetchMethod
    && attempts[winner].method === data.fetchMethod;

  attempts.forEach((attempt, i) => {
    if (!attempt) return;
    const tierId = normalizeTierId(attempt.method, attempt.tier);
    if (!stats[domain]) stats[domain] = {};
    if (!stats[domain][tierId]) stats[domain][tierId] = emptyBucket();
    const bucket = stats[domain][tierId];
    const partial = attempt.partial === true || (retroPartial && i === winner);
    if (attempt.success && !partial) {
      bucket.successes++;
    } else {
      bucket.failures++;
      if (partial) bucket.partials++;
    }
  });
  return true;
}

/**
 * Stats view for buildSkipConfig(): partial results count as successes, so a
 * tier is only skip-listed when it NEVER returned any usable text.
 */
function toSkipStats(stats) {
  const out = {};
  for (const [domain, tiers] of Object.entries(stats || {})) {
    out[domain] = {};
    for (const [tierId, s] of Object.entries(tiers)) {
      const partials = s.partials || 0;
      out[domain][tierId] = { successes: s.successes + partials, failures: s.failures - partials };
    }
  }
  return out;
}

module.exports = { tallyFileAttempts, toSkipStats, winningAttemptIndex };
