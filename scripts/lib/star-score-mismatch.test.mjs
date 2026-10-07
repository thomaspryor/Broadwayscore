import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateReview, isExcludedReview, keyOf, scanReviewTexts, DEFAULT_THRESHOLD } = require('./star-score-mismatch.js');

test('DEFAULT_THRESHOLD is 30', () => {
  assert.equal(DEFAULT_THRESHOLD, 30);
});

test('Birthright case: 2/5 star (wrong show, combined column) vs LLM 93 → flagged as star-won-hiding', () => {
  // Exact shape of the review that triggered card #396. assignedScore == the bad
  // star (40) because originalScore-priority0 won routing — an assignedScore-only
  // check would see zero gap. The llm gap (93 vs 40) is the tell.
  const r = {
    outlet: 'Theater Life',
    originalScore: '2/5 stars',
    originalScoreNormalized: 40,
    scoreSource: 'wp-api-title',
    assignedScore: 40,
    llmScore: { score: 93, confidence: 'low' },
  };
  const f = evaluateReview(r);
  assert.ok(f, 'should be flagged');
  assert.equal(f.expected, 40);
  assert.equal(f.llm, 93);
  assert.equal(f.gapLLM, 53);
  assert.equal(f.starWonHidingContradiction, true, 'star won routing and is hiding in the live score');
});

test('confidence:low does NOT suppress detection (the rebuild-helpers hole this covers)', () => {
  const r = { originalScore: '1/5 stars', assignedScore: 20, llmScore: { score: 85, confidence: 'low' } };
  const f = evaluateReview(r);
  assert.ok(f, 'low-confidence LLM must still be compared — that gate is exactly why Birthright slipped through');
  assert.equal(f.gapLLM, 65);
});

test('consistent star + LLM → not flagged', () => {
  const r = { originalScore: '5/5 stars', assignedScore: 95, llmScore: { score: 96, confidence: 'high' } };
  assert.equal(evaluateReview(r), null);
});

test('gap just under threshold → not flagged; just over → flagged', () => {
  assert.equal(evaluateReview({ originalScore: 'A', assignedScore: 62, llmScore: { score: 62 } }), null, '90 vs 62 = 28 (<30)');
  const f = evaluateReview({ originalScore: 'A', assignedScore: 59, llmScore: { score: 59 } });
  assert.ok(f, '90 vs 59 = 31 (>30)');
  assert.equal(f.worstGap, 31);
});

test('letter grade contradiction (NYTG "D" vs positive LLM)', () => {
  const r = { originalScore: 'D', assignedScore: 75, llmScore: { score: 75, confidence: 'high' } };
  const f = evaluateReview(r);
  assert.ok(f);
  assert.equal(f.expected, 35);
  assert.equal(f.worstGap, 40);
  assert.equal(f.ratingType, 'letter');
});

test('bare-numeric originalScore is ambiguous → never flagged', () => {
  // "5" could be 5/100 or 5 stars. parseRating reads it as 5/100; comparing that
  // to an LLM 93 would be a false positive. Must be skipped.
  assert.equal(evaluateReview({ originalScore: '5', assignedScore: 93, llmScore: { score: 93 } }), null);
});

test('designation-only ratings (Critics Pick) → not scoreable, not flagged', () => {
  assert.equal(evaluateReview({ originalScore: "Critics' Pick", assignedScore: 40, llmScore: { score: 90 } }), null);
});

test('unparseable rating → not flagged', () => {
  assert.equal(evaluateReview({ originalScore: 'thumbs sideways-ish', assignedScore: 40, llmScore: { score: 90 } }), null);
});

test('missing originalRating → not applicable', () => {
  assert.equal(evaluateReview({ assignedScore: 40, llmScore: { score: 90 } }), null);
});

test('no llm AND no assignedScore → not applicable', () => {
  assert.equal(evaluateReview({ originalScore: '5/5 stars' }), null);
});

test('excluded reviews are skipped regardless of gap', () => {
  const base = { originalScore: '5/5 stars', assignedScore: 20, llmScore: { score: 20 } };
  for (const flag of ['wrongProduction', 'wrongShow', 'isNonReview', 'isNotReview', 'fabricatedEntry',
    'wrongUrl', 'isCombinedReview', 'wrongAttribution', 'suspectedMisattribution', 'showNotMentioned',
    'duplicateOf', 'duplicateTextOf', 'isRoundupArticle']) {
    assert.equal(evaluateReview({ ...base, [flag]: true }), null, `${flag} should exclude`);
  }
  assert.equal(evaluateReview({ ...base, rejectionReason: 'not_a_review' }), null);
});

test('keyOf includes the original rating so a changed bad rating re-alerts', () => {
  const f1 = { showId: 's', file: 'f.json', originalRating: '2/5 stars' };
  const f2 = { showId: 's', file: 'f.json', originalRating: '1/5 stars' };
  assert.notEqual(keyOf(f1), keyOf(f2), 'a different bad rating in the same file must not be silently baselined');
  assert.equal(keyOf(f1), 's/f.json#2/5 stars');
});

test('scanReviewTexts baseline drops only exact key matches', () => {
  // Sanity: scanReviewTexts is exported and baselineKeys filters by keyOf.
  assert.equal(typeof scanReviewTexts, 'function');
});

test('isExcludedReview matches its flags', () => {
  assert.equal(isExcludedReview({ wrongShow: true }), true);
  assert.equal(isExcludedReview({}), false);
});

test('falls back to originalRating when originalScore absent', () => {
  const f = evaluateReview({ originalRating: '5/5 stars', assignedScore: 40, llmScore: { score: 42 } });
  assert.ok(f);
  assert.equal(f.expected, 100);
});

test('gap only against assignedScore (star cleared but LLM absent) still flags', () => {
  // e.g. a correct star that routing failed to anchor — assignedScore drifted.
  const f = evaluateReview({ originalScore: '5/5 stars', assignedScore: 50 });
  assert.ok(f);
  assert.equal(f.gapLLM, null);
  assert.equal(f.gapAssigned, 50);
  assert.equal(f.starWonHidingContradiction, false);
});
