import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateCollectedBeforePreviews,
  isCollectedBeforePreviewsHold,
  COLLECTED_BEFORE_PREVIEWS_REASON,
  COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX,
} = require('./collected-before-previews.js');
const { shouldAutoClearCollectedBeforePreviews } = require('./wrong-production-autoclear.js');
const dateGuard = require('./date-guard.js');
const reviewGuards = require('./review-guards.js');
const realAutoClear = require('./wrong-production-autoclear.js');
const { decideInclusion } = require('../scoring-delta.js');
const { shouldRetryDatelessHoldFetch } = require('./review-slot-guards.js');
const { shouldFlagCollectedBeforePreviews } = require('./collected-before-previews.js');
const { resolveGuardReviewDate } = require('./backfill-publish-date.js');

// Real shape (BRO-4855): Two Girls off-Broadway 2026 carried four School Girls
// excerpts relayed by nyc-theatre with no url and no publishDate, first seen
// six days before the first preview.
const TWO_GIRLS = {
  id: 'two-girls-off-broadway-2026',
  previewsStartDate: '2026-10-07',
  openingDate: '2026-10-18',
  status: 'previews',
  category: 'off-broadway',
  earliestDate: '2026-10-07',
};
const TWO_GIRLS_DEADLINE = {
  outletId: 'deadline',
  outlet: 'Deadline',
  url: null,
  source: 'nyc-theatre',
  contentTier: 'excerpt',
  firstSeenAt: '2026-10-01T19:53:49.469Z',
  assignedScore: 85,
};

describe('evaluateCollectedBeforePreviews', () => {
  test('Two Girls fixture: dateless excerpt first seen before previews is held', () => {
    const v = evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: TWO_GIRLS });
    assert.strictEqual(v.flag, true);
    assert.strictEqual(v.reason, COLLECTED_BEFORE_PREVIEWS_REASON);
    assert.strictEqual(v.anchor, '2026-10-07');
    assert.strictEqual(v.firstSeen, '2026-10-01');
  });

  test('a usable date always abstains (dated guards own it)', () => {
    const v = evaluateCollectedBeforePreviews({ hasUsableDate: true, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: TWO_GIRLS });
    assert.strictEqual(v.flag, false);
  });

  test('first seen inside the margin (or after previews) is not held', () => {
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-10-05T10:00:00Z', show: TWO_GIRLS }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-10-19T02:00:00Z', show: TWO_GIRLS }).flag, false);
    // Exactly at the margin edge: 2026-10-04T00:00Z is not before anchor - 3d.
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-10-04T00:00:00Z', show: TWO_GIRLS }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-10-03T23:59:59Z', show: TWO_GIRLS }).flag, true);
  });

  test('declared priorRuns or tourLegs abstain', () => {
    const withPrior = { ...TWO_GIRLS, priorRuns: [{ startDate: '2025-01-01', endDate: '2025-03-01' }] };
    const withTour = { ...TWO_GIRLS, tourLegs: [{ city: 'Chicago' }] };
    assert.deepStrictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: withPrior }), { flag: false, reason: 'prior_runs_declared' });
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: withTour }).flag, false);
    // An empty priorRuns array is not a declaration.
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: { ...TWO_GIRLS, priorRuns: [] } }).flag, true);
  });

  test('previewsStartDate after openingDate is bad data: abstain', () => {
    const bad = { ...TWO_GIRLS, previewsStartDate: '2026-11-01', openingDate: '2026-10-18' };
    assert.deepStrictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: bad }), { flag: false, reason: 'previews_after_opening' });
  });

  test('openingDate-only show: a review first seen during previews is NOT held', () => {
    const noPreviews = { id: 'x', openingDate: '2026-10-18' };
    // 10 days before opening: inside the undated preview period.
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-10-08T00:00:00Z', show: noPreviews }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-10-16T00:00:00Z', show: noPreviews }).flag, false);
    // Months before opening: held, anchored at openingDate - 35d.
    const v = evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: '2026-08-01T00:00:00Z', show: noPreviews });
    assert.strictEqual(v.flag, true);
    assert.strictEqual(v.anchor, '2026-09-13');
  });

  test('missing/unparseable firstSeenAt or show dates abstain', () => {
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: undefined, show: TWO_GIRLS }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: 'not a date', show: TWO_GIRLS }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: { id: 'x' } }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: null }).flag, false);
    assert.strictEqual(evaluateCollectedBeforePreviews({ hasUsableDate: false, firstSeenAt: TWO_GIRLS_DEADLINE.firstSeenAt, show: { id: 'x', previewsStartDate: 'TBA' } }).flag, false);
  });

  test('date-guard.js re-exports the same evaluator (scoring-delta per-side replay)', () => {
    assert.strictEqual(dateGuard.evaluateCollectedBeforePreviews, evaluateCollectedBeforePreviews);
  });
});

describe('shouldAutoClearCollectedBeforePreviews', () => {
  const held = {
    ...TWO_GIRLS_DEADLINE,
    wrongProduction: true,
    wrongProductionReason: COLLECTED_BEFORE_PREVIEWS_REASON,
    wrongProductionNote: `${COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX}: no publishDate and first seen 2026-10-01`,
  };

  test('hold persists while the basis stands', () => {
    assert.strictEqual(isCollectedBeforePreviewsHold(held), true);
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(held, { hasUsableDate: false, show: TWO_GIRLS }), false);
  });

  test('releases when a usable date arrives', () => {
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(held, { hasUsableDate: true, show: TWO_GIRLS }), true);
  });

  test('releases when the show gains priorRuns', () => {
    const show = { ...TWO_GIRLS, priorRuns: [{ startDate: '2025-01-01', endDate: '2025-02-01' }] };
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(held, { hasUsableDate: false, show }), true);
  });

  test('a human override always releases; ensemble consensus blocks the date release', () => {
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews({ ...held, wrongProductionManualClear: true }, { hasUsableDate: false, show: TWO_GIRLS }), true);
    const ensemble = { ...held, rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check', rejectionAgreeCount: 2 };
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(ensemble, { hasUsableDate: true, show: TWO_GIRLS }), false);
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews({ ...ensemble, humanReviewedWrongProduction: false }, { hasUsableDate: false, show: TWO_GIRLS }), true);
  });

  test('never touches another guard\'s flag', () => {
    const other = { ...TWO_GIRLS_DEADLINE, wrongProduction: true, wrongProductionReason: 'dateless-revival', wrongProductionNote: 'Dateless revival guard: x' };
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(other, { hasUsableDate: true, show: TWO_GIRLS }), false);
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews({ ...held, wrongProduction: false }, { hasUsableDate: true, show: TWO_GIRLS }), false);
  });
});

describe('scoring-delta decideInclusion replays the hold', () => {
  const guardsWith = { ...reviewGuards, __dateGuard: dateGuard, __priorRunLib: realAutoClear };
  const { evaluateCollectedBeforePreviews: _omit, shouldFlagCollectedBeforePreviews: _omit2, ...dateGuardWithout } = dateGuard;
  const guardsWithout = { ...reviewGuards, __dateGuard: dateGuardWithout, __priorRunLib: realAutoClear };

  test('Two Girls excerpt: held under the working guards, included under a baseline without the guard', () => {
    const withGuard = decideInclusion(TWO_GIRLS_DEADLINE, TWO_GIRLS, guardsWith);
    const withoutGuard = decideInclusion(TWO_GIRLS_DEADLINE, TWO_GIRLS, guardsWithout);
    assert.deepStrictEqual(withGuard, { included: false, reason: 'collected-before-previews' });
    assert.strictEqual(withoutGuard.included, true, JSON.stringify(withoutGuard));
  });

  test('a stored hold is released in the replay once a publishDate arrives', () => {
    const heldDated = {
      ...TWO_GIRLS_DEADLINE,
      publishDate: '2026-10-18',
      wrongProduction: true,
      wrongProductionReason: COLLECTED_BEFORE_PREVIEWS_REASON,
      wrongProductionNote: `${COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX}: x`,
    };
    assert.strictEqual(decideInclusion(heldDated, TWO_GIRLS, guardsWith).included, true);
  });
});

describe('collector date retry covers the hold', () => {
  test('a held record with a stored url gets the stored-url date fetch', () => {
    const held = {
      ...TWO_GIRLS_DEADLINE,
      url: 'https://deadline.com/some-review/',
      wrongProduction: true,
      wrongProductionReason: COLLECTED_BEFORE_PREVIEWS_REASON,
    };
    assert.strictEqual(shouldRetryDatelessHoldFetch(held), true);
    assert.strictEqual(shouldRetryDatelessHoldFetch({ ...held, url: null }), false);
    assert.strictEqual(shouldRetryDatelessHoldFetch({ ...held, wrongProductionReason: 'other', wrongProductionNote: 'x' }), false);
  });
});

describe('human verdict wins: clear-then-flag cycle is stable', () => {
  // Mirrors rebuild-all-reviews.js: the auto-clear runs first in the pre-opening
  // pass, then (wrongProduction now false) the dateless flag pass re-decides.
  function rebuildCycle(rec, show) {
    const d = { ...rec };
    let writes = 0;
    if (shouldAutoClearCollectedBeforePreviews(d, { hasUsableDate: false, show })) {
      d.wrongProduction = false;
      delete d.wrongProductionReason;
      delete d.wrongProductionNote;
      writes++;
    }
    if (!d.wrongProduction && shouldFlagCollectedBeforePreviews(d, { hasUsableDate: false, show }).flag) {
      d.wrongProduction = true;
      d.wrongProductionReason = COLLECTED_BEFORE_PREVIEWS_REASON;
      d.wrongProductionNote = `${COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX}: x`;
      writes++;
    }
    return { d, writes };
  }

  const heldBase = {
    ...TWO_GIRLS_DEADLINE,
    wrongProduction: true,
    wrongProductionReason: COLLECTED_BEFORE_PREVIEWS_REASON,
    wrongProductionNote: `${COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX}: x`,
  };

  test('human-confirmed hold (humanReviewedWrongProduction === true) stays held, even when a date arrives', () => {
    const held = { ...heldBase, humanReviewedWrongProduction: true };
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(held, { hasUsableDate: false, show: TWO_GIRLS }), false);
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews(held, { hasUsableDate: true, show: TWO_GIRLS }), false);
    assert.strictEqual(shouldAutoClearCollectedBeforePreviews({ ...heldBase, wrongProductionProvenance: 'manual' }, { hasUsableDate: true, show: TWO_GIRLS }), false);
    const run1 = rebuildCycle(held, TWO_GIRLS);
    assert.strictEqual(run1.d.wrongProduction, true);
    assert.strictEqual(run1.writes, 0);
  });

  test('human-rejected hold (humanReviewedWrongProduction === false) releases once and is never re-flagged', () => {
    const held = { ...heldBase, humanReviewedWrongProduction: false };
    const first = rebuildCycle(held, TWO_GIRLS);
    assert.strictEqual(first.d.wrongProduction, false);
    assert.strictEqual(first.writes, 1);
    const second = rebuildCycle(first.d, TWO_GIRLS);
    assert.strictEqual(second.d.wrongProduction, false);
    assert.strictEqual(second.writes, 0);
  });

  test('flag pass never stamps a record a human already marked (=== true)', () => {
    const unflagged = { ...TWO_GIRLS_DEADLINE, humanReviewedWrongProduction: true };
    assert.strictEqual(shouldFlagCollectedBeforePreviews(unflagged, { hasUsableDate: false, show: TWO_GIRLS }).flag, false);
  });

  test('without a human verdict the hold is stable (no writes on re-run)', () => {
    const first = rebuildCycle(TWO_GIRLS_DEADLINE, TWO_GIRLS);
    assert.strictEqual(first.d.wrongProduction, true);
    assert.strictEqual(rebuildCycle(first.d, TWO_GIRLS).writes, 0);
  });
});

describe('effective date matches the rebuild (url date counts)', () => {
  // Shape of ivanov-west-end-2026/consequence--unknown.json: no publishDate,
  // a full YYYY-MM-DD in the url, first seen before previews.
  const IVANOV = { id: 'ivanov-west-end-2026', previewsStartDate: '2027-07-27', openingDate: '2027-08-03', category: 'west-end', earliestDate: '2027-07-27' };
  const CONSEQUENCE = {
    outletId: 'consequence',
    url: 'https://concerts.consequence.net/events/ivanov-at-bridge-theatre-on-2027-08-20-19-30',
    publishDate: null,
    firstSeenAt: '2026-10-11T14:56:21.098Z',
    assignedScore: 70,
    contentTier: 'excerpt',
  };

  test('resolveGuardReviewDate falls back to the url date', () => {
    const d = resolveGuardReviewDate(CONSEQUENCE, IVANOV);
    assert.ok(d, 'expected a url-derived date');
    assert.strictEqual(d.toISOString().slice(0, 10), '2027-08-20');
  });

  test('scoring-delta replay does NOT hold a publishDate-less review with a url date', () => {
    const guards = { ...reviewGuards, __dateGuard: dateGuard, __priorRunLib: realAutoClear };
    const r = decideInclusion(CONSEQUENCE, IVANOV, guards);
    assert.notStrictEqual(r.reason, 'collected-before-previews', JSON.stringify(r));
  });

  test('a stored hold on a review with a url date is released in the replay', () => {
    const guards = { ...reviewGuards, __dateGuard: dateGuard, __priorRunLib: realAutoClear };
    const held = { ...CONSEQUENCE, wrongProduction: true, wrongProductionReason: COLLECTED_BEFORE_PREVIEWS_REASON };
    const r = decideInclusion(held, IVANOV, guards);
    assert.notStrictEqual(r.reason, 'wrongProduction', JSON.stringify(r));
    assert.notStrictEqual(r.reason, 'collected-before-previews', JSON.stringify(r));
  });
});
