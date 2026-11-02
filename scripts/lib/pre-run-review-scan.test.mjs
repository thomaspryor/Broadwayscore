import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const { classify } = createRequire(import.meta.url)('./pre-run-review-scan.js');
test('classify: opera unflagged link, carried transfer and uncovered rows', () => {
  const shows = [
    { id: 'op', type: 'opera', openingDate: '2026-11-01', priorRuns: [{ id: 'op-old', openingDate: '2018-01-01' }] },
    { id: 'tr', type: 'play', openingDate: '2026-03-01', priorRuns: [{ openingDate: '2025-01-01', closingDate: '2025-03-01' }] },
    { id: 'un', type: 'play', openingDate: '2026-03-01' },
  ];
  const reviews = [
    { showId: 'op', outletId: 'nyt', publishDate: '2018-01-05' },
    { showId: 'tr', outletId: 'guardian', publishDate: '2025-02-01' },
    { showId: 'un', outletId: 'stage', publishDate: '2024-05-01' },
    { showId: 'un', outletId: 'recent', publishDate: '2026-02-20' },
  ];
  const by = Object.fromEntries(classify({ shows, reviews }).map((e) => [e.showId, e]));
  assert.deepEqual(by.op.cls, { 'opera-unflagged': 1 });
  assert.deepEqual(by.tr.cls, { 'carried-by-link': 1 });
  assert.deepEqual(by.un.cls, { uncovered: 1 });
  assert.equal(by.un.rows, 1);
});
