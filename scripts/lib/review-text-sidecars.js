'use strict';
/**
 * Which files in data/review-texts/<show>/ are sidecars, not reviews.
 *
 * `_`-prefixed .json files are per-show metadata kept next to the reviews:
 * _blocklist.json (poller-blocklist.js), _ingest-rejections.json
 * (ingest-rejection-cache.js, BRO-2926), and whatever comes next.
 * rebuild-all-reviews.js already skips every `_` file; readers that named one
 * sidecar at a time read the next one as a review: validate-review-texts --gate
 * failed the trunk on _ingest-rejections.json (no showId/outletId), and the
 * outlet-mismatch rename pass would have renamed it to unknown--unknown.json,
 * the BRO-1011 incident (BRO-5261 retro-review). failed-fetches.json is the
 * legacy name of the same idea.
 */

/** True for a sidecar file name (never a review). */
function isReviewTextSidecar(name) {
  const f = String(name || '');
  return f.endsWith('.json') && (f.startsWith('_') || f === 'failed-fetches.json');
}

/** True for a file name that holds a review: a .json that is not a sidecar. */
function isReviewTextFile(name) {
  const f = String(name || '');
  return f.endsWith('.json') && !isReviewTextSidecar(f);
}

module.exports = { isReviewTextSidecar, isReviewTextFile };
