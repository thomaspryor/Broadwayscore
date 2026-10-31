import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateScoreConfidence, getConfidenceFloors } = require('./score-confidence-gate.js');

// outletId encodes the tier: 't1-a' -> 1
const getOutletTier = id => Number(id.split('-')[0].slice(1));
const rev = (tier, i, conf = 'high', score = 80) => ({ outletId: `t${tier}-${i}`, assignedScore: score, scoreConfidence: conf });
const many = (tier, n, conf) => Array.from({ length: n }, (_, i) => rev(tier, i, conf));

test('Broadway floors match the opening-night broadcast gate (12 / 3 T1 / 3 T2 / 8 hi-conf)', () => {
  assert.deepEqual(getConfidenceFloors('broadway'), { total: 12, t1: 3, t2: 3, highConfidence: 8 });
  const ok = evaluateScoreConfidence({ showReviews: [...many(1, 3), ...many(2, 3), ...many(3, 6)], category: 'broadway', getOutletTier });
  assert.equal(ok.ok, true);
  const short = evaluateScoreConfidence({ showReviews: [...many(1, 3), ...many(2, 3), ...many(3, 5)], category: 'broadway', getOutletTier });
  assert.equal(short.ok, false);
  assert.deepEqual(short.reasons, ['11/12 total']);
});

test('London markets use the lower floors; everything else the Broadway ones', () => {
  for (const cat of ['west-end', 'off-west-end']) {
    assert.deepEqual(getConfidenceFloors(cat), { total: 8, t1: 3, t2: 2, highConfidence: 6 }, cat);
  }
  assert.deepEqual(getConfidenceFloors('off-broadway'), { total: 12, t1: 3, t2: 3, highConfidence: 8 });
});

test('a caller can pass its own floors', () => {
  const reviews = [...many(1, 3), ...many(2, 2), ...many(3, 3)];
  assert.equal(evaluateScoreConfidence({ showReviews: reviews, category: 'off-broadway', getOutletTier }).ok, false);
  assert.equal(evaluateScoreConfidence({ showReviews: reviews, category: 'off-broadway', getOutletTier, floors: { total: 8, t1: 3, t2: 2, highConfidence: 6 } }).ok, true);
});

test('excerpt-only reviews do not count toward high confidence', () => {
  const reviews = [...many(1, 3, 'low'), ...many(2, 3, 'low'), ...many(3, 6, 'high')];
  const r = evaluateScoreConfidence({ showReviews: reviews, category: 'broadway', getOutletTier });
  assert.equal(r.counts.highConfidence, 6);
  assert.deepEqual(r.reasons, ['hi-conf:6/8']);
});

test('unscored reviews are ignored; returning runs need reviews of this run', () => {
  const reviews = [...many(1, 3), ...many(2, 3), ...many(3, 6), { outletId: 't1-x', assignedScore: null }];
  const r = evaluateScoreConfidence({ showReviews: reviews, category: 'broadway', getOutletTier, newReviewCount: 5 });
  assert.equal(r.counts.total, 12);
  assert.deepEqual(r.reasons, ['this-run:5/6']);
});

test('opening-night status readiness reads the same floors (no second copy)', () => {
  const { getThresholds } = require('./opening-night-readiness.js');
  for (const m of ['broadway', 'west-end']) {
    const f = getConfidenceFloors(m);
    assert.deepEqual(getThresholds(m), { MIN_REVIEWS: f.total, MIN_T1_REVIEWS: f.t1, MIN_T2_REVIEWS: f.t2, MIN_HIGH_CONFIDENCE: f.highConfidence }, m);
  }
});
