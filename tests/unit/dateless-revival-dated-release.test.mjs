/**
 * BRO-5877: a dated, >365d-early review carrying a stale
 * wrongProductionReason 'dateless-revival' must stay excluded after one
 * rebuild pass.
 *
 * Incident: harry-potter-and-the-cursed-child-one-part-west-end-2026/
 * front-row-center--tulis-mccall.json (publishDate 2018-04-30, 3084d before
 * 2026-10-09) flipped wrongProduction true→false twice on 2026-10-21:
 *   1. A stale reason 'dateless-revival' survived the original hold release.
 *      flag-wrong-production-by-date.js re-flagged it with a "Date guard:" note
 *      (it writes only the note), and shouldAutoClearDatelessRevival keyed on
 *      the reason, so the next rebuild released the dated flag. An approved
 *      plan that re-set wrongProduction was released the same way.
 *   2. The rebuild's own pre-window guard then held the flag on
 *      cv-affirms-production at any gap (and its inclusion pass scored the
 *      review), unlike the flagger's shouldHoldDateGuardFlag 180-day rule.
 *
 * The pass below replays rebuild-all-reviews.js's order with the real
 * predicates: dateless-revival auto-clear, then the pre-window flag decision.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldAutoClearDatelessRevival } = require('../../scripts/lib/wrong-production-autoclear.js');
const { rebuildPreWindowHold } = require('../../scripts/lib/date-guard-hold.js');
const { evaluatePreWindowInclusion } = require('../../scripts/lib/date-guard.js');

const SHOW = {
  id: 'harry-potter-and-the-cursed-child-one-part-west-end-2026',
  category: 'west-end',
  previewsStartDate: '2026-10-09',
  openingDate: '2026-10-21',
  priorRuns: [{ id: 'harry-potter-and-the-cursed-child-both-parts-west-end-2021', openingDate: '2016-07-30', closingDate: '2026-09-20', inheritReviews: false }],
};

const CV_AFFIRMS = {
  isValid: true,
  confidence: 'high',
  wrongProduction: false,
  wrongArticle: false,
};

const DATE_GUARD_NOTE = 'Date guard: review 2018-04-30 is 3063d before 2026-10-09 (preview/open) — likely different production';

function base(over = {}) {
  return {
    showId: SHOW.id,
    outletId: 'front-row-center',
    publishDate: '2018-04-30',
    contentVerification: { ...CV_AFFIRMS },
    ...over,
  };
}

// One rebuild pass over a single file, in rebuild-all-reviews.js order.
// The opt-out priorRun (inheritReviews:false) is not a pre-window exemption.
function rebuildPass(input) {
  const d = structuredClone(input);
  const reviewDate = new Date(`${d.publishDate}T00:00:00Z`);
  if (shouldAutoClearDatelessRevival(d, { hasUsableDate: true })) {
    d.wrongProduction = false;
    delete d.wrongProductionNote;
    if (d.wrongProductionReason === 'dateless-revival') delete d.wrongProductionReason;
  }
  if (d.wrongProduction) return d;
  const preWindow = evaluatePreWindowInclusion({
    pubDate: reviewDate,
    showEarliest: new Date('2026-10-09T00:00:00Z'),
    isFlexCategory: true,
    priorRuns: [],
    tourLegs: undefined,
  });
  if (preWindow.exclude && !rebuildPreWindowHold({ review: d, show: SHOW }).hold) {
    d.wrongProduction = true;
    d.wrongProductionNote = 'Pre-opening guard: pre-window date';
  }
  return d;
}

describe('BRO-5877: dated dateless-revival flag survives a rebuild pass', () => {
  test('stale reason under a Date guard note is not released', () => {
    const d = base({ wrongProduction: true, wrongProductionReason: 'dateless-revival', wrongProductionNote: DATE_GUARD_NOTE });
    assert.equal(shouldAutoClearDatelessRevival(d, { hasUsableDate: true }), false);
    assert.equal(rebuildPass(d).wrongProduction, true);
  });

  test('approved-fix flag with a stale dateless-revival reason is not released', () => {
    const d = base({
      wrongProduction: true,
      wrongProductionReason: 'dateless-revival',
      approvedFixes: [{ fixId: 'x', field: 'wrongProduction', at: '2026-10-20T22:17:13.614Z', newValue: true }],
    });
    assert.equal(shouldAutoClearDatelessRevival(d, { hasUsableDate: true }), false);
    assert.equal(rebuildPass(d).wrongProduction, true);
  });

  test('a released bare-reason hold is re-flagged by the dated guard despite cv-affirms', () => {
    const d = base({ wrongProduction: true, wrongProductionReason: 'dateless-revival' });
    assert.equal(shouldAutoClearDatelessRevival(d, { hasUsableDate: true }), true);
    const after = rebuildPass(d);
    assert.equal(after.wrongProduction, true);
    assert.match(after.wrongProductionNote, /^Pre-opening guard:/);
  });

  test('cv-affirms alone does not hold a 3084d-early date; it still holds a near-window one', () => {
    assert.equal(rebuildPreWindowHold({ review: base(), show: SHOW }).hold, false);
    const near = base({ publishDate: '2026-07-01' });
    assert.equal(rebuildPreWindowHold({ review: near, show: SHOW }).hold, true);
  });

  test('the real dateless-revival hold (its own note) still releases on a date', () => {
    const d = base({
      wrongProduction: true,
      wrongProductionReason: 'dateless-revival',
      wrongProductionNote: 'Dateless revival guard: no publishDate on multi-production title that has not yet opened',
    });
    assert.equal(shouldAutoClearDatelessRevival(d, { hasUsableDate: true }), true);
  });

  test('humanReviewedWrongProduction === true holds; === false releases', () => {
    const held = base({ wrongProduction: true, wrongProductionReason: 'dateless-revival', humanReviewedWrongProduction: true });
    assert.equal(shouldAutoClearDatelessRevival(held, { hasUsableDate: false }), false);
    const overridden = base({ wrongProduction: true, wrongProductionReason: 'dateless-revival', humanReviewedWrongProduction: false });
    assert.equal(shouldAutoClearDatelessRevival(overridden, { hasUsableDate: false }), true);
  });
});
