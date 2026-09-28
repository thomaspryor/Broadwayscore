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
  for (const id of ['beetlejuice-2019', 'beetlejuice-2022', 'beetlejuice-2025']) {
    const show = getShowById(id);
    assert.ok(show, id);
    assert.deepEqual(getToursOf(show).map(t => t.id), ['beetlejuice-tour-2022'], id);
  }
  assert.deepEqual(getToursOf({ id: 'beetlejuice-west-end-2026', title: 'Beetlejuice', category: 'west-end' }), []);
  assert.deepEqual(getToursOf({ id: 'hamilton-2015', title: 'Hamilton', category: 'broadway' }), []);
});
