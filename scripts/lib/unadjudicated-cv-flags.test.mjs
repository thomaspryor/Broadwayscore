import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { isUnadjudicatedCvFlag, findUnadjudicatedCounted } = createRequire(import.meta.url)('./unadjudicated-cv-flags.js');

const reason = 'Collector LLM: not a review (preview, high conf) but already scored — needs human verification';

test('flag without adjudication is unadjudicated', () => {
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: reason }), true);
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: 'Collector LLM: not a review (news, high conf)' }), true);
});
test('isNonReview or nonReviewManualClear counts as adjudicated', () => {
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: reason, isNonReview: true }), false);
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: reason, nonReviewManualClear: true }), false);
});
test('wrong-article human clear and duplicate pointers are not unadjudicated', () => {
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: reason, wrongArticleManualClear: true }), false);
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: reason, duplicateOf: 'other.json' }), false);
});
test('unrelated reasons and missing reasons are ignored', () => {
  assert.equal(isUnadjudicatedCvFlag({ needsReviewReason: 'truncated text' }), false);
  assert.equal(isUnadjudicatedCvFlag({}), false);
  assert.equal(isUnadjudicatedCvFlag(null), false);
});
test('only counted showId+url pairs are reported', () => {
  const files = [
    { showId: 'a', file: 'x.json', record: { url: 'u1', needsReviewReason: reason } },
    { showId: 'a', file: 'y.json', record: { url: 'u2', needsReviewReason: reason } },
    { showId: 'b', file: 'z.json', record: { url: 'u1', needsReviewReason: reason, nonReviewManualClear: true } },
  ];
  const hits = findUnadjudicatedCounted(files, [{ showId: 'a', url: 'u1' }, { showId: 'b', url: 'u1' }]);
  assert.deepEqual(hits.map((h) => h.file), ['x.json']);
});
