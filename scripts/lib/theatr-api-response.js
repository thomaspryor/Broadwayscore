/**
 * Pure response-validation for Theatr's /shows/query endpoint.
 *
 * Extracted from scripts/scrape-theatr-audience.js (BRO-2743) so the error
 * path is unit-testable: the Aug 30 - Sep 5 2026 repeat-failure incident was
 * an upstream Theatr DB schema error ("Unknown column 'genre_category'")
 * that self-resolved after 5 days. Our own code never changed — what mattered
 * was that `data.message` surfaced the real cause immediately instead of an
 * opaque crash, which is the behavior this guards against regressing.
 */

function assertShowsQuerySuccess(data) {
  if (!data || !data.success) {
    const message = (data && data.message) || 'unknown error';
    throw new Error(`Shows query failed: ${message}`);
  }
  return data.content.records;
}

module.exports = { assertShowsQuerySuccess };
