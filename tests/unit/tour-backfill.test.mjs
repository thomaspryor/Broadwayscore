/**
 * tour-backfill (BRO-4211): which archived tour reviews move from a Broadway
 * show to its tour entry, and how each file is rewritten.
 *
 * Run: node --test tests/unit/tour-backfill.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyTourBackfill, prepareTourMove } = require('../../scripts/lib/tour-backfill.js');

const tourFlag = { wrongProduction: true, wrongProductionReason: 'BWW regional/tour review (denver)', url: 'https://www.denverpost.com/x' };

test('a tour-flagged review moves', () => {
  assert.deepEqual(classifyTourBackfill(tourFlag), { action: 'move', reason: 'tour-review' });
});

test('files that are not tour-flagged, already routed, or unusable stay put', () => {
  assert.equal(classifyTourBackfill({ wrongProduction: false }).reason, 'not-flagged');
  assert.equal(classifyTourBackfill({ wrongProduction: true, wrongProductionReason: 'URL year mismatch' }).reason, 'flag-not-tour');
  assert.equal(classifyTourBackfill({ ...tourFlag, routedFromShowId: 'x' }).reason, 'already-routed');
  assert.equal(classifyTourBackfill({ ...tourFlag, isNonReview: true }).reason, 'non-review');
  assert.equal(classifyTourBackfill({ ...tourFlag, duplicateOf: 'a.json' }).reason, 'duplicate');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongShow: true }).reason, 'wrong-show');
});

test('pre-Broadway tryouts and UK productions are not the North American tour', () => {
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongProductionReason: 'Tour review | pre-Broadway tryout at Emerson Colonial' }).reason, 'tryout');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongFullText: 'The pre-Broadway tryout in Boston is a delight.' }).reason, 'tryout');
  assert.equal(classifyTourBackfill({ ...tourFlag, wrongProductionReason: 'UK tour stop review' }).reason, 'uk-production');
});

// Four A Beautiful Noise tour-stop reviews (Houston, Minneapolis, Cleveland, Revue)
// carried only this generic label; it must not read as tryout evidence.
test('the generic "Tour/regional/pre-Broadway production" label is not tryout evidence', () => {
  const d = { ...tourFlag, wrongProductionReason: 'Tour/regional/pre-Broadway production, not Broadway. Flagged by contamination safety net' };
  assert.equal(classifyTourBackfill(d).action, 'move');
});

test('dated reviews before the Broadway opening or the tour launch stay put', () => {
  const ctx = { broadwayOpeningDate: '2022-12-04', tourLaunchDate: '2024-08-01' };
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2022-07-01' }, ctx).reason, 'before-broadway-opening');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2023-05-01' }, ctx).reason, 'before-tour-launch');
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: '2024-07-28' }, ctx).action, 'move'); // within a week of launch
  assert.equal(classifyTourBackfill({ ...tourFlag }, ctx).action, 'move'); // undated: no date rule applies
  // Real case: a 2019 Broadway review in beetlejuice-2025 whose note says "not the 2025 tour stop".
  assert.equal(classifyTourBackfill({ ...tourFlag, publishDate: 'April 29th, 2019' }, ctx).reason, 'before-broadway-opening');
});

test('prepareTourMove restores the text, sets aside Broadway-relative verdicts, stamps provenance', () => {
  const src = {
    showId: 'beetlejuice-2022', ...tourFlag, wrongFullText: 'Review text', fullText: null, contentTier: 'invalid',
    textQuality: 'truncated', contentVerification: { isValid: false }, verifiedBy: 'llm:gemini', possibleTourReview: true,
  };
  const out = prepareTourMove(src, { fromShowId: 'beetlejuice-2022', tourId: 'beetlejuice-tour-2023', at: '2026-09-28T00:00:00Z' });
  assert.equal(out.showId, 'beetlejuice-tour-2023');
  assert.equal(out.fullText, 'Review text');
  assert.equal(out.wrongFullText, undefined);
  assert.equal(out.contentTier, 'truncated');
  for (const k of ['wrongProduction', 'wrongProductionReason', 'contentVerification', 'verifiedBy', 'possibleTourReview']) {
    assert.ok(!(k in out), `${k} should be removed`);
  }
  assert.equal(out.routedPriorVerdicts.wrongProduction, true);
  assert.deepEqual(out.routedPriorVerdicts.contentVerification, { isValid: false });
  assert.equal(out.routedFromShowId, 'beetlejuice-2022');
  assert.equal(src.wrongProduction, true, 'input must not be mutated');
});

test('a wrong_production rejection is set aside on the move; other rejections stand', () => {
  const base = { showId: 'shucked-2023', ...tourFlag, wrongFullText: 't' };
  const moved = prepareTourMove({ ...base, rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: 'touring, not Broadway' },
    { fromShowId: 'shucked-2023', tourId: 'shucked-tour-2024' });
  assert.ok(!('rejectionReason' in moved));
  assert.equal(moved.routedPriorVerdicts.rejectionReason, 'wrong_production');
  const kept = prepareTourMove({ ...base, rejectionReason: 'not_a_review' }, { fromShowId: 'shucked-2023', tourId: 'shucked-tour-2024' });
  assert.equal(kept.rejectionReason, 'not_a_review');
});
