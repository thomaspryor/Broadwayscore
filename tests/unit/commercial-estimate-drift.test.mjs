import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planModelLossResizes } = require('../../scripts/lib/commercial-designations');

const estimate = (designation, pct, extra = {}) => ({
  designation,
  designationBasis: 'model-estimate',
  modelDataQuality: 'low',
  modelReturnedExCreditPct: [pct - 10, pct, pct + 10],
  ...extra,
});

for (const [from, pct, to] of [
  ['Flop', 30, 'Fizzle'],
  ['Fizzle', 29.9, 'Flop'],
  ['Fizzle', 100, 'Trickle'],
  ['Trickle', 99.9, 'Fizzle'],
  ['Trickle', 150, 'Windfall'],
  ['Windfall', 149.9, 'Trickle'],
  ['Windfall', 20, 'Flop'],
]) {
  test(`model-estimate drift: ${from} at ${pct}% becomes ${to}`, () => {
    assert.deepEqual(planModelLossResizes([['show', estimate(from, pct)]]), {
      moves: [{ key: 'show', from, to }], held: false,
    });
  });
}

test('an analyst figure still sizes the estimate ahead of the model', () => {
  const entry = estimate('Windfall', 170, { analystRecoupPct: [100, 120] });
  assert.equal(planModelLossResizes([['show', entry]]).moves[0]?.to, 'Trickle');
});

test('drift preserves human locks, reported winners and special classes', () => {
  const entries = [
    ['locked', estimate('Trickle', 20, { humanReviewedDesignation: true })],
    ['reported', estimate('Windfall', 20, { designationBasis: undefined, recouped: true })],
    ['announced', estimate('Trickle', 20, { recouped: true })],
    ...['TBD', 'Easy Winner', 'Miracle', 'Nonprofit', 'Tour Stop'].map(d => [d, estimate(d, 20)]),
  ];
  assert.deepEqual(planModelLossResizes(entries), { moves: [], held: false });
});

test('a recorded non-recoupment cannot become an estimated winner', () => {
  const entries = ['Did Not Recoup', 'Fizzle', 'Flop'].map(d => [d, estimate(d, 124, { recouped: false })]);
  assert.deepEqual(planModelLossResizes(entries), { moves: [], held: false });
});

test('the two reported DNR keepers stay locked even if model quality improves', () => {
  const entries = [123.8, 124].map(pct => [String(pct), estimate('Did Not Recoup', pct, {
    designationBasis: 'reported-loss', recouped: false,
    humanReviewedDesignation: true, modelDataQuality: 'medium',
  })]);
  assert.deepEqual(planModelLossResizes(entries), { moves: [], held: false });
});

test('a missing estimate does not turn an estimated winner into a reported loss', () => {
  assert.deepEqual(planModelLossResizes([['show', { designation: 'Trickle', designationBasis: 'model-estimate' }]]), {
    moves: [], held: false,
  });
});

test('estimated winner moves share the existing batch circuit breaker', () => {
  const entries = Array.from({ length: 4 }, (_, i) => [`show-${i}`, estimate('Windfall', 120)]);
  const result = planModelLossResizes(entries);
  assert.equal(result.moves.length, 4);
  assert.equal(result.held, true);
});
