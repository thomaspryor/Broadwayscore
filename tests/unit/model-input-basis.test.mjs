// BRO-5849: which model inputs are guesses, and what a guess may not do.
// Runs in the tsx batch (imports src TS for the page wording).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { modelInputBasis, decidedByGuess, canResizeByModel } = require('../../scripts/lib/model-input-basis');
const { planModelLossResizes } = require('../../scripts/lib/commercial-designations');
const { estimatedInputNotes, toPublicShowCommercial } = await import('../../src/lib/commercial-display.ts');

test('a stated guess is read from the fields the model already reads', () => {
  assert.deepEqual(modelInputBasis({ capitalization: 5e6, isEstimate: { capitalization: true } }), [{ input: 'capitalization', basis: 'estimate' }]);
  assert.deepEqual(modelInputBasis({ capitalization: 5e6, capitalizationSource: 'Estimate: SEC Form D ceiling, issuer inferred' }), [{ input: 'capitalization', basis: 'estimate' }]);
  assert.deepEqual(modelInputBasis({ weeklyRunningCost: 765e3, costMethodology: 'reddit-standard' }), [{ input: 'weeklyRunningCost', basis: 'estimate' }]);
  assert.deepEqual(modelInputBasis({ weeklyRunningCost: 765e3, costMethodology: 'trade-reported' }), []);
});

test('a Form D maximum is a ceiling (a disclosed fact), not a guess', () => {
  const b = modelInputBasis({ capitalization: 9.5e6, capitalizationBasis: 'maximum', capitalizationSource: 'Form D maximum' });
  assert.deepEqual(b, [{ input: 'capitalization', basis: 'ceiling' }]);
  assert.equal(decidedByGuess({ modelInputBasis: b }), false);
});

test('a missing cost with a type default is listed, a comparables fill is a guess', () => {
  assert.deepEqual(modelInputBasis({ capitalization: 8e6 }, { weeklyFixedCostSource: 'estimated' }), [{ input: 'weeklyRunningCost', basis: 'type-default' }]);
  assert.equal(decidedByGuess({ modelInputBasis: modelInputBasis({}, { capitalizationEstimate: {} }) }), true);
});

test('a guess never relabels a show; the same record with a fact does', () => {
  const entry = { designation: 'Fizzle', status: 'closed', recouped: null, modelRecoupmentPct: [-90, -80, -70], modelDataQuality: 'medium', modelMethod: 'weekly-model' };
  const moved = (e) => planModelLossResizes([['k', e]].filter(([, x]) => canResizeByModel(x))).moves.length;
  const base = moved(entry);
  assert.equal(base, 1);
  const guessed = { ...entry, modelInputBasis: [{ input: 'capitalization', basis: 'estimate' }] };
  assert.equal(moved(guessed), 0);
  // The record's own analyst estimate still sizes its label.
  assert.equal(canResizeByModel({ ...guessed, analystRecoupPct: [10, 20] }), true);
});

test('page wording names the kind of guess, never "lead" or the forum', () => {
  const notes = estimatedInputNotes({ costMethodology: 'reddit-standard', modelInputBasis: [{ input: 'weeklyRunningCost', basis: 'estimate' }, { input: 'capitalization', basis: 'comparables' }] });
  assert.equal(notes.length, 2);
  for (const n of notes) assert.doesNotMatch(n, /lead|reddit/i);
  assert.match(notes[0], /fan-forum estimate, unconfirmed/);
  assert.deepEqual(estimatedInputNotes({ modelInputBasis: [{ input: 'capitalization', basis: 'ceiling' }] }), []);
  // A cost marked an estimate by its source text, with no methodology, is not called an "industry" estimate.
  assert.deepEqual(estimatedInputNotes({ costMethodology: 'trade-reported', modelInputBasis: [{ input: 'weeklyRunningCost', basis: 'estimate' }] }), ['weekly running cost is an unconfirmed estimate']);
  assert.match(estimatedInputNotes({ costMethodology: 'industry-estimate', modelInputBasis: [{ input: 'weeklyRunningCost', basis: 'estimate' }] })[0], /industry estimate/);
});

test('the public payload carries the wording, never the raw basis list', () => {
  const pub = toPublicShowCommercial({ designation: 'TBD', modelInputBasis: [{ input: 'capitalization', basis: 'estimate' }] });
  assert.deepEqual(pub.estimatedInputs, ['capitalization is an unconfirmed estimate']);
  assert.equal('modelInputBasis' in pub, false);
});
