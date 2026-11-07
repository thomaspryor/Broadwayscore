/**
 * BRO-6762: dependency-free check for a borrowed publish date (aggregator listing
 * date, or the archive.org first capture, which is only an upper bound).
 *
 * Kept free of requires on purpose: read-only audit scripts (safe-form allowlist,
 * scripts/lib/safe-form-allowlist.test.mjs) pull in the date guards, and the
 * heavier publish-date-provenance graph reaches network code.
 */
function isFallbackPublishDate(review) {
  const src = String((review && review.dateSource) || '');
  return src === 'archive-first-capture' || src.startsWith('aggregator-listing');
}

module.exports = { isFallbackPublishDate };
