'use strict';
/**
 * What audit-critic-coverage.js should record for one critic once every
 * source fetch has settled (BRO-6927). When every source failed, the old code
 * ran the coverage diff against zero articles and printed "0 missing", which
 * read as a clean bill of health (seen for Frank Scheck with Muck Rack blocked).
 *
 * @param {number} articleCount  articles returned by the sources that worked
 * @param {Array<{source:string,error:string}>} errors  sources that failed
 * @param {number} sourceCount  sources that were asked
 * @returns {'ok'|'no-articles-found'|'all-sources-failed'|'fetch-failed'}
 */
function criticFetchStatus(articleCount, errors, sourceCount) {
  if (articleCount > 0) return 'ok';
  if (errors.length > 0 && errors.length >= sourceCount) return 'all-sources-failed';
  // Some sources failed and the rest returned nothing: still unknown, not zero.
  if (errors.length > 0) return 'fetch-failed';
  return 'no-articles-found';
}

/** Progress-line text for one REPORT entry. */
function criticProgressLabel(entry) {
  if (entry.error === 'all-sources-failed' || entry.error === 'fetch-failed') return `FETCH FAILED (${(entry.errors || []).map(e => e.source).join(', ')})`;
  if (entry.error) return entry.error;
  return `${entry.missingCount || 0} missing`;
}

module.exports = { criticFetchStatus, criticProgressLabel };
