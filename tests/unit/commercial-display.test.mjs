/**
 * Q1 conflict rule + quality floor contract tests (Sprint 3, task #142).
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * gate-logic precedent.
 *
 * Owner sign-off 2026-07-13 (plan card 39c637c5-416f-8132):
 *  - Producer announcements are ground truth. recouped:true → render the
 *    announcement; NEVER quote the recoupment model on that show.
 *  - Quality floor: modelDataQuality:'low' and modelMethod:'ai-estimated'
 *    numbers stay off the card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  getRecoupmentDisplayMode,
  meetsModelQualityFloor,
  isEditorialRecoupment,
  formatRecoupedDate,
} = await import('../../src/lib/commercial-display.ts');

const base = {
  designation: 'TBD',
  capitalization: 10_000_000,
  capitalizationSource: 'SEC',
  weeklyRunningCost: 600_000,
  recouped: null,
  recoupedDate: null,
  recoupedWeeks: null,
};

test('Q1: announced recoupment always wins — model is never quoted', () => {
  // Real conflict shape (our-town): producers announced, model disagrees.
  const conflict = {
    ...base,
    recouped: true,
    recoupedDate: '2025-01',
    recoupedSource: 'Playbill grosses; Deadline (hints)',
    modelRecouped: false,
    modelRecoupmentPct: [27, 51.9, 75],
    modelDataQuality: 'medium',
    modelMethod: 'weekly-model',
  };
  assert.equal(getRecoupmentDisplayMode(conflict), 'announced');

  // Model AGREES (hamilton shape) — still announcement only, no model quote.
  const agree = { ...conflict, modelRecouped: true, modelRecoupmentPct: [14418, 15926, 17248] };
  assert.equal(getRecoupmentDisplayMode(agree), 'announced');

  // Even an uncited recouped:true must never fall through to a dual display.
  const uncited = { ...base, recouped: true, modelRecoupmentPct: [50, 60, 70] };
  assert.equal(getRecoupmentDisplayMode(uncited), 'announced');
});

test('model renders only without an announced state AND above the quality floor', () => {
  const model = {
    ...base,
    recouped: null,
    modelRecoupmentPct: [40, 55, 70],
    modelDataQuality: 'high',
    modelMethod: 'weekly-model',
  };
  assert.equal(getRecoupmentDisplayMode(model), 'model');

  // recouped:false is not an announced-recouped state — model still renders.
  assert.equal(getRecoupmentDisplayMode({ ...model, recouped: false }), 'model');
});

test('quality floor: low quality and ai-estimated model output are hidden', () => {
  const model = { ...base, modelRecoupmentPct: [40, 55, 70], modelMethod: 'weekly-model' };
  assert.equal(getRecoupmentDisplayMode({ ...model, modelDataQuality: 'low' }), 'none');
  assert.equal(
    getRecoupmentDisplayMode({ ...model, modelDataQuality: 'medium', modelMethod: 'ai-estimated' }),
    'none'
  );
  assert.equal(meetsModelQualityFloor({ ...base, modelDataQuality: 'low' }), false);
  assert.equal(meetsModelQualityFloor({ ...base, modelMethod: 'ai-estimated' }), false);
  assert.equal(meetsModelQualityFloor({ ...base, modelDataQuality: 'high', modelMethod: 'weekly-model' }), true);
  // Missing model metadata is not below the floor (nothing to hide).
  assert.equal(meetsModelQualityFloor(base), true);
});

test('legacy AI research estimate is NOT a fallback when the model is floored', () => {
  const floored = {
    ...base,
    modelRecoupmentPct: [10, 20, 30],
    modelDataQuality: 'low',
    modelMethod: 'ai-estimated',
    estimatedRecoupmentPct: [60, 80],
    estimatedRecoupmentSource: "GPT DR: 'Estimated 60-80% of cap recovered.'",
  };
  assert.equal(getRecoupmentDisplayMode(floored), 'none');
});

test('editorial keeps (Q3) are labeled, announced shows are not', () => {
  // The flag alone decides — recoupedSource is prose and is never parsed.
  // All three Q3 owner keeps (Sweeney Todd, Appropriate, Into the Woods)
  // carry humanReviewedDesignation:true and none has a producer
  // announcement, so all three must read "editorial assessment". The
  // ship-check reviewers caught the earlier regex version rendering
  // "Producers announced recoupment in 2022" for Into the Woods — false.
  const editorial = {
    ...base,
    recouped: true,
    humanReviewedDesignation: true,
    recoupedSource:
      'No producer announcement; Broadway Journal (Aug 25 2023) projected recoupment ~fall 2023. Kept recouped:true per owner review 2026-07-13.',
  };
  assert.equal(isEditorialRecoupment(editorial), true);
  assert.equal(getRecoupmentDisplayMode(editorial), 'announced');

  // into-the-woods-2022 shape: trade listing, no announcement phrase —
  // still editorial because the owner flagged it.
  assert.equal(
    isEditorialRecoupment({
      ...editorial,
      recoupedSource: 'Broadway Journal (Aug 25 2023) lists Into the Woods among 2022-23 commercial winners.',
    }),
    true
  );

  // Plain announced show (no flag) — announced copy.
  assert.equal(
    isEditorialRecoupment({ ...base, recouped: true, recoupedSource: 'Variety (Mar 2016)' }),
    false
  );

  // Flag without recouped:true never labels (e.g. leopoldstadt-2022
  // designation lock with recouped:false).
  assert.equal(
    isEditorialRecoupment({ ...base, recouped: false, humanReviewedDesignation: true }),
    false
  );
});

test('formatRecoupedDate handles YYYY-MM, YYYY, and junk', () => {
  assert.equal(formatRecoupedDate('2025-01'), 'January 2025');
  assert.equal(formatRecoupedDate('2022-12'), 'December 2022');
  assert.equal(formatRecoupedDate('1999'), '1999');
  assert.equal(formatRecoupedDate('2025-13'), '2025'); // out-of-range month → year
  assert.equal(formatRecoupedDate(null), null);
  assert.equal(formatRecoupedDate(''), null);
  assert.equal(formatRecoupedDate('circa 2020'), null);
});
