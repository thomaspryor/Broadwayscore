/**
 * getToursOf (BRO-4211 Phase D): which Broadway pages get the "On tour" /
 * "National tour" line. A tour's tourOf names one Broadway run, but every
 * Broadway production of that title should link to it: Beetlejuice's tour
 * points at beetlejuice-2019, while beetlejuice-2025 is the page people land on.
 *
 * The tour flag is read when the module loads, so it is set before the import.
 * data-core.test.ts covers the flag-off case (always empty).
 *
 * Run: npx tsx --test tests/unit/tour-links.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_FEATURES = 'tour';

test('every Broadway production of the title links its tour; other shows and markets do not', async () => {
  const { getToursOf, getShowById } = await import('../../src/lib/data-core');
  const tour = getShowById('beetlejuice-tour-2022');
  assert.ok(tour, 'beetlejuice-tour-2022 exists in shows.json');
  // Live shows.json gains tours over time (beetlejuice-tour-2026 broke an
  // exact-list assertion, BRO-4650), so pin the invariants, not the list:
  // the original tour is linked, every production gets the same set, and
  // nothing outside the title leaks in.
  let first: string[] | undefined;
  for (const id of ['beetlejuice-2019', 'beetlejuice-2022', 'beetlejuice-2025']) {
    const show = getShowById(id);
    assert.ok(show, id);
    const tours = getToursOf(show).map(t => t.id).sort();
    assert.ok(tours.includes('beetlejuice-tour-2022'), id);
    for (const t of tours) assert.equal(getShowById(t)?.title, 'Beetlejuice', `${id} -> ${t}`);
    if (first) assert.deepEqual(tours, first, id);
    else first = tours;
  }
  assert.deepEqual(getToursOf({ id: 'beetlejuice-west-end-2026', title: 'Beetlejuice', category: 'west-end' }), []);
  // A synthetic title: any real show (Hamilton was used here) can gain a tour.
  assert.deepEqual(getToursOf({ id: 'no-such-show-2015', title: 'No Such Show Title', category: 'broadway' }), []);
});
