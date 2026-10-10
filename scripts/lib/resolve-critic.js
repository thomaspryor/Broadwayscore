/**
 * Pure critic resolution for ingest-review-from-url (BRO-4655).
 *
 * newyorktheater.me's WP byline is just "Jonathan"; the ingest used it as-is and
 * wrote nyt-theater--jonathan.json next to 378 nyt-theater--jonathan-mandell.json
 * files. A first-name-only byline that is the first token of the outlet's
 * registry defaultCritic is promoted to the full defaultCritic; an empty/Unknown
 * byline falls back to defaultCritic only for standingCoverage outlets.
 * multiAuthor outlets never get defaultCritic (shouldFillDefaultCritic).
 */
const { shouldFillDefaultCritic } = require('./critic-fill-rules');

const isUnknown = (s) => !s || /^unknown$/i.test(String(s).trim());

/**
 * @param {{criticArg?: string, lsaCritic?: string, byline?: string, stageCritic?: string,
 *          outletEntry?: {defaultCritic?: string, multiAuthor?: boolean, standingCoverage?: boolean}}} p
 * @returns {string}
 */
function resolveCritic({ criticArg, lsaCritic, byline, stageCritic, outletEntry } = {}) {
  if (criticArg) return criticArg;
  if (lsaCritic) return lsaCritic;
  const canFill = shouldFillDefaultCritic(outletEntry);
  const dc = canFill ? String(outletEntry.defaultCritic).trim() : '';
  const b = byline ? String(byline).trim() : '';
  if (b && !isUnknown(b)) {
    const tokens = b.split(/\s+/);
    if (dc && tokens.length === 1 && dc.split(/\s+/).length > 1 &&
        dc.split(/\s+/)[0].toLowerCase() === b.toLowerCase()) return dc;
    return b;
  }
  if (stageCritic) return stageCritic;
  if (dc && outletEntry.standingCoverage === true) return dc;
  return 'Unknown';
}

module.exports = { resolveCritic };
