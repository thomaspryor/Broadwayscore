import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { needsOpeningDate, findMissingOpeningDates } = createRequire(import.meta.url)('./opening-date-required.js');

test('open/closed without openingDate needs one; previews/upcoming/dated do not', () => {
  assert.equal(needsOpeningDate({ status: 'closed' }), true);
  assert.equal(needsOpeningDate({ status: 'open', openingDate: null }), true);
  assert.equal(needsOpeningDate({ status: 'closed', openingDate: '2025-01-01' }), false);
  assert.equal(needsOpeningDate({ status: 'previews' }), false);
  assert.equal(needsOpeningDate({ status: 'upcoming' }), false);
});
test('baselined ids are tolerated, new ones are flagged', () => {
  const r = findMissingOpeningDates([{ id: 'a', status: 'closed' }, { id: 'b', status: 'open' }], new Set(['a']));
  assert.deepEqual(r.newOffenders.map((s) => s.id), ['b']);
  assert.deepEqual(r.baselined.map((s) => s.id), ['a']);
});
test('real corpus: no offender outside the frozen baseline', () => {
  const shows = createRequire(import.meta.url)('../../data/shows.json').shows;
  assert.deepEqual(findMissingOpeningDates(shows).newOffenders.map((s) => s.id), []);
});
