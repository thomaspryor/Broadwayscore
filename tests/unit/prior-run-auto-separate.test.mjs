import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inheritPriorRunReviews, RERUN_SEPARATE_MIN_OUTLETS } = require('../../scripts/lib/prior-run-sibling.js');

const older = { id: 'x-2025', title: 'X', openingDate: '2025-03-01', closingDate: '2025-06-01' };
const newer = (extra = {}) => ({ id: 'x-2026', title: 'X', previewsStartDate: '2026-09-01', openingDate: '2026-09-10',
  priorRuns: [{ id: 'x-2025', openingDate: '2025-03-01', closingDate: '2025-06-01', ...extra }] });
const rev = (showId, outlet, date) => ({ showId, outletId: outlet, criticName: outlet, publishDate: date, url: `https://${outlet}.com/${showId}` });
const oldReviews = ['a', 'b', 'c'].map(o => rev('x-2025', o, '2025-03-05'));
const fresh = (n) => Array.from({ length: n }, (_, i) => rev('x-2026', `new${i}`, '2026-09-11'));

test('few re-reviews: earlier run still carried', () => {
  const r = inheritPriorRunReviews([...oldReviews, ...fresh(RERUN_SEPARATE_MIN_OUTLETS - 1)], [older, newer()]);
  assert.equal(r.inherited.length, 3);
});
test('many outlets re-reviewed: earlier run is separated', () => {
  const r = inheritPriorRunReviews([...oldReviews, ...fresh(RERUN_SEPARATE_MIN_OUTLETS)], [older, newer()]);
  assert.equal(r.inherited.length, 0);
});
test('explicit inheritReviews:true overrides the auto-separation', () => {
  const r = inheritPriorRunReviews([...oldReviews, ...fresh(RERUN_SEPARATE_MIN_OUTLETS + 3)], [older, newer({ inheritReviews: true })]);
  assert.equal(r.inherited.length, 3);
});

test('leased show: its not-rebuilt rows count toward the outlet tally (no flip during the lease)', () => {
  const r = inheritPriorRunReviews(oldReviews, [older, newer()], { leasedReviews: fresh(RERUN_SEPARATE_MIN_OUTLETS) });
  assert.equal(r.inherited.length, 0);
});

test('collectCarriedFiles applies the same separation (gap audit agrees with the rebuild)', () => {
  const { collectCarriedFiles } = require('../../scripts/lib/prior-run-sibling.js');
  const files = (id) => (id === 'x-2025' ? oldReviews : fresh(RERUN_SEPARATE_MIN_OUTLETS));
  const deps = { loadFiles: files, isCovered: () => true };
  assert.equal(collectCarriedFiles(newer(), [older, newer()], deps).length, 0);
  const few = { loadFiles: (id) => (id === 'x-2025' ? oldReviews : fresh(2)), isCovered: () => true };
  assert.equal(collectCarriedFiles(newer(), [older, newer()], few).length, 3);
});
