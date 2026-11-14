'use strict';

/**
 * Pure decision fn for collect-review-texts.js's optional wall-clock budget.
 * maxDurationMs=0 (unset) means "no budget" — matches CONFIG.maxDurationMs's
 * default so long-running callers (bulk-collect-review-texts.yml,
 * collect-review-texts.yml) are unaffected.
 */
function isTimeBudgetExceeded({ startTime, now, maxDurationMs }) {
  if (!maxDurationMs) return false;
  return (now - startTime) >= maxDurationMs;
}

module.exports = { isTimeBudgetExceeded };
