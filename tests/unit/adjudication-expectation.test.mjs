/**
 * adjudicationExpectation (BRO-4211): the contamination adjudicator's expected
 * production per show category. Before the tour case a national-tour show fell
 * through to "Broadway", so every tour review in the queue read as wrong-market.
 *
 * Run: node --test tests/unit/adjudication-expectation.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { adjudicationExpectation } = require('../../scripts/lib/adjudication-expectation.js');

test('tour shows expect the national tour; the Broadway run is a wrong production', () => {
  const { expectedType, wrongTypes } = adjudicationExpectation('tour');
  assert.equal(expectedType, 'national tour');
  assert.match(wrongTypes, /original Broadway run/);
  assert.doesNotMatch(wrongTypes, /^national tour/);
});

// Wording for existing categories is byte-identical to the pre-extraction inline code.
test('existing categories keep their exact wording', () => {
  const cases = {
    broadway: ['Broadway', 'national tour, regional theater, pre-Broadway tryout, film/TV adaptation, streaming special'],
    'off-broadway': ['Off-Broadway', 'national tour, regional theater, film/TV adaptation, streaming special, or a BROADWAY (not Off-Broadway) production'],
    'west-end': ['West End', 'national tour, regional theater, film/TV adaptation, streaming special, or a Broadway/Off-Broadway (not West End) production'],
    'off-west-end': ['Off-West End', 'national tour, regional theater, film/TV adaptation, streaming special, or a Broadway/Off-Broadway (not West End) production'],
    regional: ['Broadway', 'national tour, regional theater, pre-Broadway tryout, film/TV adaptation, streaming special'],
  };
  for (const [category, [expectedType, wrongTypes]] of Object.entries(cases)) {
    const got = adjudicationExpectation(category);
    assert.deepEqual({ expectedType: got.expectedType, wrongTypes: got.wrongTypes }, { expectedType, wrongTypes }, category);
  }
});

test('context paragraph: forward-tour note for existing categories, Broadway-mention note for tours', () => {
  for (const category of ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'regional']) {
    const { expectedType, contextNote } = adjudicationExpectation(category);
    assert.ok(contextNote.startsWith('A FORWARD-LOOKING mention of a future tour'), category);
    assert.ok(contextNote.includes(`review of the CURRENT ${expectedType} run`), category);
  }
  const tour = adjudicationExpectation('tour').contextNote;
  assert.ok(!tour.includes('FORWARD-LOOKING mention of a future tour'));
  assert.match(tour, /original Broadway run/);
});
