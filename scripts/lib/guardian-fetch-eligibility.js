'use strict';
/**
 * Which Guardian review files fetch-guardian-reviews.js should call the Content API for (BRO-6964).
 *
 * Before: a file that already held body text was skipped unless the run passed --backfill-ratings, and no
 * scheduled or poller dispatch passes it. A Guardian row that got its text from another route (SERP, gather,
 * a manual add) therefore never asked the API for its starRating, was scored by the LLM with no star, and
 * stayed outside the 3/5 band (Billy Crystal 860: 3/5 on the page, 77 on the site).
 *
 * Now: a file with text but no recorded rating is always eligible (one cheap API call, no body rewrite);
 * a file with text and a rating is skipped; a file with no text is eligible when it has a URL.
 */

const has = (v) => v !== null && v !== undefined && v !== '';

/** True when the review file already carries the outlet's own rating in any field the pipeline reads. */
function hasRecordedRating(data) {
  return has(data.originalScore) || has(data.originalRating) || has(data.starRating);
}

/**
 * @param {object} data           review-texts file contents
 * @param {object} opts
 * @param {number} opts.minTextLength  text shorter than this counts as "no text"
 * @returns {{eligible: boolean, mode?: 'fetch-text'|'rating-only', reason?: string}}
 */
function guardianFetchEligibility(data, { minTextLength = 200 } = {}) {
  const hasText = !!(data.fullText && data.fullText.length > minTextLength);
  if (data.wrongProduction || data.wrongShow || data.duplicateOf) return { eligible: false, reason: 'excluded-row' };
  if (hasText && hasRecordedRating(data)) return { eligible: false, reason: 'has-text-and-rating' };
  if (!data.url) return { eligible: false, reason: 'no-url' };
  // BRO-7446: a Guardian review URL always carries /yyyy/mon/dd/. A dateless stub
  // (serp-discovery: .../stage/2026/nov/ms-blakk-for-president-play, sibling of the real
  // .../2026/nov/05/... file) is not an article path: the API 404s it on every run.
  if (!isDatedGuardianArticleUrl(data.url)) return { eligible: false, reason: 'undated-url' };
  // Rating-only: the API already answered "no star" for this row. Do not ask again every run.
  if (hasText && data.guardianApi && data.guardianApi.fetchedAt && !data.guardianApi.starRating) {
    return { eligible: false, reason: 'api-has-no-star' };
  }
  return { eligible: true, mode: hasText ? 'rating-only' : 'fetch-text' };
}

/** True for theguardian.com article URLs with the /yyyy/mon/dd/ segment the Content API resolves. */
function isDatedGuardianArticleUrl(url) {
  return /\/\d{4}\/[a-z]{3}\/\d{1,2}\//i.test(String(url || ''));
}

/**
 * Should fetch-guardian-reviews.js exit non-zero? A 404 ("could not be found") is a stale-row data
 * problem, not a broken fetch; only real failures with nothing fetched fail the workflow (BRO-7446).
 */
function shouldFailRun({ fetched, failed, notFound }) {
  return fetched === 0 && (failed - notFound) > 0;
}

module.exports = { guardianFetchEligibility, hasRecordedRating, isDatedGuardianArticleUrl, shouldFailRun };
