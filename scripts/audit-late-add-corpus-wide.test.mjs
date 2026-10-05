import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { sweepLateAdds } = createRequire(import.meta.url)('./audit-late-add-corpus-wide.js');

const early = (showId) => ({ showId, assignedScore: 80, publishDate: '2020-01-01', outletId: 'nyt' });
const base = { previewsStartDate: '2020-06-01', market: 'broadway' };
const reviews = ['a', 'b', 'c', 'd', 'e'].map(early);

test('unlinked late-add is flagged', () => {
  const r = sweepLateAdds([{ id: 'a', title: 'A', ...base }], reviews);
  assert.deepEqual(r.flagged.map((f) => f.showId), ['a']);
  assert.equal(r.explained.length, 0);
});

test('priorRuns / transferOf links remove the flag', () => {
  const shows = [
    { id: 'b', title: 'B', ...base, priorRuns: [{ venue: 'x' }] },
    { id: 'c', title: 'C', ...base, transferOf: 'a' },
  ];
  const r = sweepLateAdds(shows, reviews);
  assert.equal(r.flagged.length, 0);
  assert.deepEqual(r.explained.map((f) => f.showId).sort(), ['b', 'c']);
});

test('empty priorRuns does not count as a link', () => {
  const r = sweepLateAdds([{ id: 'd', title: 'D', ...base, priorRuns: [] }], reviews);
  assert.deepEqual(r.flagged.map((f) => f.showId), ['d']);
});
