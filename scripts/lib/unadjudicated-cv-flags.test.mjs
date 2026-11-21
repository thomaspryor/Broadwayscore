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

// BRO-7344: the stuck CV-promoted isNonReview class.
const { isStuckCvPromotedNonReview, findStuckCvPromotedNonReview } = createRequire(import.meta.url)('./unadjudicated-cv-flags.js');
const stuck = () => ({
  isNonReview: true,
  isNonReviewReason: 'CV-promoted (not a review): ',
  contentVerificationPromoted: 'rebuild: promoted from contentVerification (heuristic, medium)',
  contentVerification: { articleType: 'review', articleTypeConfidence: 'high', isValid: true, wrongArticle: false },
  fullText: 'x'.repeat(400),
});

test('a CV-promoted isNonReview with a review/high CV, no score and no other flag is stuck', () => {
  assert.equal(isStuckCvPromotedNonReview(stuck()), true);
  assert.equal(findStuckCvPromotedNonReview([{ showId: 'a', file: 'x.json', record: stuck() }]).length, 1);
});
test('any adjudication, score or other exclusion takes a file out of the stuck class', () => {
  const variants = [
    { llmScore: { score: 70 } }, { humanReviewScore: 80 }, { nonReviewManualClear: true },
    { wrongProduction: true }, { wrongShow: true }, { isRoundupArticle: true },
    { duplicateOf: 'other.json' }, { rejectedAt: '2026-01-01' }, { nonReviewOverride: true },
    { isNonReviewReason: 'manual (not a review): roundup' }, { fullText: 'short' }, { isNonReview: false },
    { contentVerificationPromoted: undefined },
    { contentVerification: { articleType: 'preview', articleTypeConfidence: 'high' } },
    { contentVerification: { articleType: 'review', articleTypeConfidence: 'medium' } },
    { contentVerification: { articleType: 'review', articleTypeConfidence: 'high', wrongProduction: true } },
  ];
  for (const v of variants) assert.equal(isStuckCvPromotedNonReview({ ...stuck(), ...v }), false, JSON.stringify(v));
  assert.equal(isStuckCvPromotedNonReview(null), false);
});
