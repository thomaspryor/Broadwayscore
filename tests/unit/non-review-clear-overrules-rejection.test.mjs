/**
 * BRO-6910 follow-up: a person's "this is a review" clear (nonReviewManualClear) overrules an ensemble not_a_review
 * stamp in the rebuild, as it already does in the scorer (human-cleared-rejection.js). Theatrely's Waiting for Lefty
 * review stayed off the site until a second plan nulled the stale rejectionReason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isRejectedByReasonExclusion, isRejectedAtExclusion, nonReviewRejectionHumanCleared } = require('../../scripts/lib/review-guards.js');

test('a cleared not_a_review stamp no longer excludes', () => {
  const d = { rejectionReason: 'not_a_review', nonReviewManualClear: true, isNonReview: false };
  assert.equal(nonReviewRejectionHumanCleared(d), true);
  assert.equal(isRejectedByReasonExclusion(d), false);
  assert.equal(isRejectedAtExclusion({ ...d, rejectedAt: '2026-10-09T11:35:24.684Z' }), false);
});

test('without the clear, or for other verdicts, the stamp still excludes', () => {
  assert.equal(isRejectedByReasonExclusion({ rejectionReason: 'not_a_review' }), true);
  assert.equal(isRejectedByReasonExclusion({ rejectionReason: 'garbage_text', nonReviewManualClear: true }), true);
  assert.equal(isRejectedByReasonExclusion({ rejectionReason: 'wrong_show', nonReviewManualClear: true }), true);
  // A bare rejectedAt does not say which verdict it stamped: a non-review clear does not defer it.
  assert.equal(isRejectedAtExclusion({ rejectedAt: '2026-08-15T19:46:58.235Z', nonReviewManualClear: true }), true);
  assert.equal(nonReviewRejectionHumanCleared(null), false);
});
