// The write-path counterpart to audit-review-contamination's class A detection.
//
// Class A (a show displaying ANOTHER production's reviews) has always been
// DETECTED after the fact; nothing blocked it at write time. On 2026-08-05 a
// gather for the La Jolla tryout 'the-outsiders-world-premiere-regional-2023'
// wrote three reviews of the BROADWAY production — each dated exactly on the
// Broadway opening (0 days from it, 401 from the tryout's) — so the tryout page
// would have shown a user another production's reviews. All three already
// existed on the-outsiders-2024: pure misattributed duplicates.
//
// gather-reviews.js createReviewFile() now calls the SAME predicate the audit
// flags on, so the detector and the preventer cannot disagree about what class
// A is. This test pins that shared behaviour on the real incident's dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyClassAContamination,
  buildSiblingOpeningsMap,
} = require('../../scripts/lib/cross-market-contamination.js');

// The real pair: a La Jolla tryout and its Broadway transfer, same title.
const SHOWS = [
  { id: 'the-outsiders-world-premiere-regional-2023', title: 'The Outsiders', category: 'regional', openingDate: '2023-03-07' },
  { id: 'the-outsiders-2024', title: 'The Outsiders', category: 'broadway', openingDate: '2024-04-11' },
];

function verdictFor(showId, publishDate) {
  const map = buildSiblingOpeningsMap(SHOWS, (d) => (d ? new Date(d) : null));
  const me = SHOWS.find((s) => s.id === showId);
  const sibs = map.get(showId) || [];
  return classifyClassAContamination(
    new Date(publishDate),
    me.openingDate ? new Date(me.openingDate) : null,
    sibs.map((x) => (x && x.opening ? x.opening : x))
  );
}

test('a review dated on the Broadway opening is blocked from the tryout', () => {
  // EW, TheWrap and TimeOut were all published 2024-04-11 — the Broadway
  // opening — and all landed on the regional tryout.
  const v = verdictFor('the-outsiders-world-premiere-regional-2023', '2024-04-11');
  assert.equal(v.isClassA, true, 'must be refused at write time, not merely audited later');
  assert.equal(Math.round(v.sibDiff), 0, 'exactly on the sibling opening');
  assert.equal(Math.round(v.thisDiff), 401, 'far from its own');
});

test('the tryout\'s genuine reviews are still allowed', () => {
  // LA Times on opening day, San Diego Union-Tribune the day after — the real
  // La Jolla coverage. A guard that blocked these would be worse than the bug.
  for (const d of ['2023-03-07', '2023-03-08', '2023-03-13']) {
    assert.equal(verdictFor('the-outsiders-world-premiere-regional-2023', d).isClassA, false, d);
  }
});

test('the Broadway show keeps its own reviews', () => {
  // Symmetry check: the guard must not push contamination the other way.
  assert.equal(verdictFor('the-outsiders-2024', '2024-04-11').isClassA, false);
  assert.equal(verdictFor('the-outsiders-2024', '2024-04-12').isClassA, false);
});

test('a show with no same-title sibling is never class A', () => {
  const solo = [{ id: 'only-show-2026', title: 'Only Show', category: 'broadway', openingDate: '2026-01-01' }];
  const map = buildSiblingOpeningsMap(solo, (d) => (d ? new Date(d) : null));
  assert.equal((map.get('only-show-2026') || []).length, 0);
});

test('a missing or unparseable publish date never blocks a write', () => {
  // Fail-open: most reviews carry a date, but a guard that refused undated ones
  // would silently drop real reviews — the failure mode this whole guard exists
  // to prevent.
  assert.equal(classifyClassAContamination(null, new Date('2023-03-07'), ['2024-04-11']).isClassA, false);
  assert.equal(classifyClassAContamination(new Date('nonsense'), new Date('2023-03-07'), ['2024-04-11']).isClassA, false);
});
