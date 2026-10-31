/**
 * BRO-2841: an adjudicator national-tour verdict must NOT be cleared by the
 * region heuristic, but IS superseded by an operator-declared priorRuns /
 * tourLegs window containing the review date (the declared window is the
 * correct reason; region 'london' is a UK catch-all, not London coverage).
 *
 * Run: node --test scripts/lib/wrong-production-autoclear-adjudicated-tour.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  shouldAutoClearWrongProductionPriorRun,
  shouldAutoClearWrongProductionTourLeg,
  shouldAutoClearWrongProductionUkDualMarket,
  isAdjudicatedTourVerdict,
  supersedeAdjudicatedTourVerdict,
} = require('./wrong-production-autoclear');

const review = (over = {}) => ({
  wrongProduction: true,
  url: 'https://northwestend.com/matthew-bournes-the-car-man-sheffield-lyceum/',
  publishDate: '2026-07-22',
  wrongProductionNote: 'Auto-adjudicated: national-tour. Sheffield Lyceum.',
  wrongProductionReason: 'contamination-adjudicated: national-tour',
  ...over,
});
const priorShow = { priorRuns: [{ openingDate: '2026-06-15', closingDate: '2026-07-27', venue: 'UK Tour' }] };
const tourShow = { tourLegs: [{ startDate: '2026-07-01', endDate: '2026-07-27', venue: 'UK Tour' }] };

describe('adjudicated tour verdict vs declared windows (BRO-2841)', () => {
  it('detects tour/regional verdicts only', () => {
    assert.ok(isAdjudicatedTourVerdict(review()));
    assert.ok(isAdjudicatedTourVerdict(review({ wrongProductionReason: 'contamination-adjudicated: regional' })));
    assert.ok(!isAdjudicatedTourVerdict(review({ wrongProductionReason: 'contamination-adjudicated: film-tv' })));
    assert.ok(!isAdjudicatedTourVerdict(review({ wrongProductionNote: 'manual' })));
  });
  it('priorRuns window containing the date supersedes the verdict', () => {
    assert.strictEqual(shouldAutoClearWrongProductionPriorRun(review(), priorShow), true);
  });
  it('tourLegs window containing the date supersedes the verdict', () => {
    assert.strictEqual(shouldAutoClearWrongProductionTourLeg(review(), tourShow), true);
  });
  it('date outside the window does not clear', () => {
    assert.strictEqual(shouldAutoClearWrongProductionPriorRun(review({ publishDate: '2026-09-01' }), priorShow), false);
  });
  it('tour verdict does not yield to a non-tour priorRuns window', () => {
    const sitDown = { priorRuns: [{ openingDate: '2026-06-15', closingDate: '2026-07-27', venue: 'Sadler\'s Wells' }] };
    assert.strictEqual(shouldAutoClearWrongProductionPriorRun(review(), sitDown), false);
  });
  it('non-tour adjudicated verdicts are never overridden by a window', () => {
    const r = review({ wrongProductionReason: 'contamination-adjudicated: film-tv' });
    assert.strictEqual(shouldAutoClearWrongProductionPriorRun(r, priorShow), false);
  });
  it('region heuristic still refuses an adjudicated verdict', () => {
    assert.strictEqual(shouldAutoClearWrongProductionUkDualMarket(review(), {
      isLondonMarketShow: true, isUkUrl: false, outletIsDualOrUk: true, outletIsLondonRegion: true,
    }), false);
  });
  it('supersede strips adjudicator markers and sets allowTourSignal', () => {
    const d = review({ incompleteReason: 'wrong_content', incompleteDetail: 'contamination-adjudicated: national-tour' });
    supersedeAdjudicatedTourVerdict(d);
    assert.strictEqual(d.wrongProductionReason, undefined);
    assert.strictEqual(d.incompleteReason, undefined);
    assert.strictEqual(d.allowTourSignal, true);
  });
});
