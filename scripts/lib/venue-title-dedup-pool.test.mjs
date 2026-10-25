// Tests for the shared dedup pool used by promote-ob-historical.js and
// promote-historical-we.js (BRO-243, extracted from two identical copies —
// see ship-check P1: neither promote script had dedicated test coverage).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildVenueTitlePool, findExactDuplicate, findSubtitleDuplicateTitle } = require('./venue-title-dedup-pool.js');

test('buildVenueTitlePool drops entries missing title or venue', () => {
  const pool = buildVenueTitlePool([
    { title: 'Show A', venue: 'Some Theatre' },
    { title: 'Show B', venue: null },
    { venue: 'No Title Theatre' },
    { title: 'Show C', venue: 'Another Theatre' },
  ]);
  assert.equal(pool.length, 2);
  assert.deepEqual(pool.map(p => p.title), ['Show A', 'Show C']);
});

test('findExactDuplicate does NOT collapse two unrelated venues sharing a leading word (BRO-243)', () => {
  const pool = buildVenueTitlePool([
    { title: 'Totally Fictional Show', venue: 'Prince Edward Theatre' },
  ]);
  const dup = findExactDuplicate(pool, 'Totally Fictional Show', 'Prince of Wales Theatre');
  assert.equal(dup, null);
});

test('findExactDuplicate finds a genuine same-title same-venue duplicate', () => {
  const pool = buildVenueTitlePool([
    { title: 'The Full Monty', venue: 'Prince Edward Theatre' },
  ]);
  const dup = findExactDuplicate(pool, 'The Full Monty', 'Prince Edward Theatre');
  assert.ok(dup);
  assert.equal(dup.title, 'The Full Monty');
});

test('findExactDuplicate tolerates spelling variants via venuesMatch (Theatre/Theater)', () => {
  const pool = buildVenueTitlePool([
    { title: "St. Luke's Show", venue: "St. Luke's Theatre" },
  ]);
  const dup = findExactDuplicate(pool, "St. Luke's Show", "St. Luke's Theater");
  assert.ok(dup);
});

test('findSubtitleDuplicateTitle catches a subtitle-stripped duplicate at the SAME venue', () => {
  const pool = buildVenueTitlePool([
    { title: 'Ectoplasm', venue: 'Prince Edward Theatre' },
  ]);
  const dup = findSubtitleDuplicateTitle(pool, 'Ectoplasm: Spit and Vigor', 'Prince Edward Theatre');
  assert.equal(dup, 'Ectoplasm');
});

test('findSubtitleDuplicateTitle does NOT match a subtitle variant at a DIFFERENT (venue-collision) venue', () => {
  const pool = buildVenueTitlePool([
    { title: 'Ectoplasm', venue: 'Prince Edward Theatre' },
  ]);
  const dup = findSubtitleDuplicateTitle(pool, 'Ectoplasm: Spit and Vigor', 'Prince of Wales Theatre');
  assert.equal(dup, null);
});

test('findExactDuplicate/findSubtitleDuplicateTitle see entries pushed into the pool mid-run (same-run feedback)', () => {
  const pool = buildVenueTitlePool([]);
  assert.equal(findExactDuplicate(pool, 'New Show', 'Some Theatre'), null);
  pool.push({ title: 'New Show', venue: 'Some Theatre' });
  const dup = findExactDuplicate(pool, 'New Show', 'Some Theatre');
  assert.ok(dup);
});

// --- withinYears date-awareness (BRO-4851) ----------------------------------

test('withinYears: a same-venue revival years apart is NOT a duplicate', () => {
  const pool = buildVenueTitlePool([{ title: 'Cats', venue: 'London Palladium', openingDate: '2015-12-11' }]);
  assert.equal(findExactDuplicate(pool, 'Cats', 'London Palladium', { withinYears: 1, startDate: '2024-06-01' }), null);
  // Without withinYears the match stays date-blind (OB historical behaviour unchanged).
  assert.ok(findExactDuplicate(pool, 'Cats', 'London Palladium'));
});

test('withinYears: same production within the window IS a duplicate', () => {
  const pool = buildVenueTitlePool([{ title: 'Kyoto', venue: '@sohoplace', previewsStartDate: '2025-01-09' }]);
  assert.ok(findExactDuplicate(pool, 'Kyoto', '@sohoplace', { withinYears: 1, startDate: '2025-01-20' }));
});

test('withinYears: an unknown date on either side fails safe as a duplicate', () => {
  const pool = buildVenueTitlePool([{ title: 'Kyoto', venue: '@sohoplace' }]);
  assert.ok(findExactDuplicate(pool, 'Kyoto', '@sohoplace', { withinYears: 1, startDate: '2025-01-20' }));
  const dated = buildVenueTitlePool([{ title: 'Kyoto', venue: '@sohoplace', openingDate: '2025-01-09' }]);
  assert.ok(findExactDuplicate(dated, 'Kyoto', '@sohoplace', { withinYears: 1, startDate: null }));
});

test('venueEquals overrides venuesMatch for known naming variants', () => {
  const pool = buildVenueTitlePool([{ title: 'Here We Are', venue: 'National Theatre (Lyttelton)', openingDate: '2025-05-08' }]);
  assert.equal(findExactDuplicate(pool, 'Here We Are', 'Lyttelton Theatre'), null);
  const nt = (a, b) => /lyttelton/i.test(a) && /lyttelton/i.test(b);
  assert.ok(findExactDuplicate(pool, 'Here We Are', 'Lyttelton Theatre', { venueEquals: nt }));
});
