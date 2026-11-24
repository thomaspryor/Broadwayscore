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

// BRO-8188 (owner 2026-11-24, option A): once the broadcast readiness gate passes, the
// floors no longer hold back the draft. Thin shows and a returning production's this-run
// shortfall still wait.
test('draftMayProceed: readiness gate decides; floors waived; this-run and thin shows wait', () => {
  const { draftMayProceed } = require('./score-confidence-gate.js');
  const READY = { ready: true }, NOT_READY = { ready: false };
  // Wonderful Life, 2026-11-23: 16 scored, T1 2/3, readiness gate passed (BWW).
  const wl = evaluateScoreConfidence({ showReviews: [...many(1, 2), ...many(2, 4), ...many(3, 10)], category: 'broadway', getOutletTier });
  assert.equal(wl.ok, false);
  assert.equal(draftMayProceed(wl, READY), true);
  // same show before the readiness gate passed: waits
  assert.equal(draftMayProceed(wl, NOT_READY), false);
  // zero reviews: every floor short, readiness not met: waits (hand run without --shows)
  const empty = evaluateScoreConfidence({ showReviews: [], category: 'broadway', getOutletTier });
  assert.equal(draftMayProceed(empty, NOT_READY), false);
  // returning production short on this run's reviews, even with other floors short too
  const ret = evaluateScoreConfidence({ showReviews: [...many(1, 2), ...many(2, 3), ...many(3, 12)], category: 'broadway', getOutletTier, newReviewCount: 2 });
  assert.ok(ret.reasons.some(r => r.startsWith('this-run:')) && ret.reasons.some(r => r.startsWith('T1:')));
  assert.equal(draftMayProceed(ret, READY), false);
  // West End, T2 short only
  const we = evaluateScoreConfidence({ showReviews: [...many(1, 3), ...many(2, 1), ...many(3, 8)], category: 'west-end', getOutletTier });
  assert.deepEqual(we.reasons, ['T2:1/2']);
  assert.equal(draftMayProceed(we, READY), true);
  // an unknown future reason is not waived
  assert.equal(draftMayProceed({ ok: false, reasons: ['T1:1/3', 'wrong-production'] }, READY), false);
  // passing floors still need readiness
  const ok = evaluateScoreConfidence({ showReviews: [...many(1, 3), ...many(2, 3), ...many(3, 6)], category: 'broadway', getOutletTier });
  assert.equal(draftMayProceed(ok, READY), true);
  assert.equal(draftMayProceed(ok, NOT_READY), false);
  assert.equal(draftMayProceed(null, READY), false);
  assert.equal(draftMayProceed(wl, null), false);
});

test('send-opening-night-broadcast.js wires draftMayProceed with readiness, drafts only (not previews), after force/update', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../send-opening-night-broadcast.js', import.meta.url), 'utf8');
  const branch = src.indexOf('} else if (!SEND_TO && draftMayProceed(gate, evaluateBroadcastReadiness(');
  assert.ok(branch > 0, 'draft-early branch missing or not passing readiness');
  assert.ok(src.indexOf('} else if (FORCE_CREATE_DRAFT) {') < branch, 'force branch must come first');
  assert.ok(src.indexOf('} else if (UPDATE_UNSENT) {') < branch, 'update branch must come first');
});
