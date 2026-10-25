/**
 * Selection logic for scripts/backfill-roundup-pull-quote-compilation.js (BRO-2638).
 *
 * detectPullQuoteCompilation() only runs at write time (review-file-writer
 * Guard E4), so a compilation page that reached disk before the guard existed,
 * or through a path that skips it, stays unflagged and scores as an individual
 * review. This decides, for one review record already on disk, whether the
 * backfill should flag it. Kept pure so tests require() the real function.
 */
const { detectPullQuoteCompilation } = require('./roundup-digest');
const { shouldSkipRoundupAudit } = require('./review-guards');

/**
 * @param {object} data parsed review-text JSON
 * @returns {{ reason: string } | null} null when the file should be left alone
 */
function selectPullQuoteCompilation(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.isRoundupArticle === true) return null; // already flagged
  if (shouldSkipRoundupAudit(data)) return null; // manually cleared: respect it
  const hit = detectPullQuoteCompilation(data);
  return hit ? { reason: hit.reason } : null;
}

module.exports = { selectPullQuoteCompilation };
