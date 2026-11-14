import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { diffClosingDate, isNycCategory, planShowEvents, MAX_NEW_EVENTS } = require('./show-change-diff.js');

const feed = (extra = []) => [
  ...Array.from({ length: 1200 }, (_, i) => ({ id: `filler-${i}`, status: 'open' })),
  ...extra,
];
const show = (id, closingDate, o = {}) => ({ id, closingDate, status: 'open', ...o });

test('diffClosingDate: announced, extended, shortened, removed, unchanged', () => {
  assert.equal(diffClosingDate(null, '2027-01-04'), 'closing-announced');
  assert.equal(diffClosingDate(undefined, '2027-01-04'), 'closing-announced');
  assert.equal(diffClosingDate('2027-01-04', '2027-02-01'), 'closing-extended');
  assert.equal(diffClosingDate('2027-02-01', '2027-01-04'), 'closing-shortened');
  assert.equal(diffClosingDate('2027-01-04', null), null);
  assert.equal(diffClosingDate('2027-01-04', '2027-01-04'), null);
  assert.equal(diffClosingDate(null, null), null);
});

test('isNycCategory: Broadway and Off-Broadway only; no category means Broadway', () => {
  assert.equal(isNycCategory(undefined), true);
  assert.equal(isNycCategory('broadway'), true);
  assert.equal(isNycCategory('off-broadway'), true);
  assert.equal(isNycCategory('west-end'), false);
  assert.equal(isNycCategory('off-west-end'), false);
  assert.equal(isNycCategory('regional'), false);
});

test('planShowEvents: the first run records everything as seeded (no news from old dates)', () => {
  const r = planShowEvents({ shows: feed([show('ham-2015', '2027-01-04')]), existing: [] });
  assert.equal(r.seededRun, true);
  assert.deepEqual(r.events, [{ show_id: 'ham-2015', type: 'closing-announced', value: '2027-01-04', seeded: true }]);
});

test('planShowEvents: a later run announces a new date and records a move', () => {
  const existing = [{ show_id: 'old-2020', type: 'closing-announced', value: '2026-12-01' }];
  const r = planShowEvents({
    shows: feed([show('ham-2015', '2027-01-04'), show('old-2020', '2026-12-15')]),
    existing,
  });
  assert.deepEqual(r.events.map(e => [e.show_id, e.type, e.value, e.seeded]), [
    ['ham-2015', 'closing-announced', '2027-01-04', false],
    ['old-2020', 'closing-moved', '2026-12-15', false],
  ]);
});

test('planShowEvents: a date already recorded is never recorded twice', () => {
  const existing = [{ show_id: 'ham-2015', type: 'closing-announced', value: '2027-01-04' }];
  const r = planShowEvents({ shows: feed([show('ham-2015', '2027-01-04')]), existing });
  assert.equal(r.events.length, 0);
});

test('planShowEvents: skips London, closed shows and malformed dates', () => {
  const existing = [{ show_id: 'x', type: 'closing-announced', value: '2026-01-01' }];
  const r = planShowEvents({
    shows: feed([
      show('a-we', '2027-01-04', { category: 'west-end' }),
      show('b-closed', '2027-01-04', { status: 'closed' }),
      show('c-bad', 'Jan 4'),
      show('d-none', null),
      show('e-ob', '2027-01-04', { category: 'off-broadway' }),
    ]),
    existing,
  });
  assert.deepEqual(r.events.map(e => e.show_id), ['e-ob']);
});

test('planShowEvents: a flood of new dates is recorded silently and flagged', () => {
  const many = Array.from({ length: MAX_NEW_EVENTS + 1 }, (_, i) => show(`s-${i}`, '2027-01-04'));
  const r = planShowEvents({ shows: feed(many), existing: [{ show_id: 'x', type: 'closing-announced', value: '2026-01-01' }] });
  assert.equal(r.capped, true);
  assert.ok(r.events.every(e => e.seeded === true));
  const few = planShowEvents({ shows: feed(many.slice(0, MAX_NEW_EVENTS)), existing: [{ show_id: 'x', type: 'closing-announced', value: '2026-01-01' }] });
  assert.equal(few.capped, false);
  assert.ok(few.events.every(e => e.seeded === false));
});

test('planShowEvents: a truncated feed aborts instead of writing', () => {
  const r = planShowEvents({ shows: [show('ham-2015', '2027-01-04')], existing: [] });
  assert.match(r.abort, /minimum/);
  assert.deepEqual(r.events, []);
});
