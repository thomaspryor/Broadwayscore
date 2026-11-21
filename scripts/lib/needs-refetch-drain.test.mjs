// BRO-4426: textless needsRefetch reviews get reserved queue slots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  NEEDS_REFETCH_DRAIN_PER_RUN, isTextlessNeedsRefetch, promoteNeedsRefetch, compareReviewPriority,
} = require('./collection-priority.js');

test('isTextlessNeedsRefetch: needs flag and no usable body', () => {
  assert.equal(isTextlessNeedsRefetch({ needsRefetch: true }), true);
  assert.equal(isTextlessNeedsRefetch({ needsRefetch: true, fullText: 'x'.repeat(150) }), true);
  assert.equal(isTextlessNeedsRefetch({ needsRefetch: true, fullText: 'x'.repeat(900) }), false);
  assert.equal(isTextlessNeedsRefetch({ fullText: '' }), false);
  assert.equal(isTextlessNeedsRefetch(null), false);
});

test('old closed-show textless review is no longer stranded past the cut', () => {
  const fresh = Array.from({ length: 400 }, (_, i) => ({
    reviewId: `new/${i}`, isOpenShow: false, recencyDate: '2026-09-01', fetchAttempts: 0, priority: 2,
  }));
  const stuck = { reviewId: 'aladdin-2014/ap', isOpenShow: false, recencyDate: '2014-03-20', fetchAttempts: 0, priority: 3, _needsRefetch: true };
  const queue = [...fresh, stuck].sort((a, b) => compareReviewPriority(a, b));
  assert.ok(queue.indexOf(stuck) >= 300, 'precondition: sorted past max_reviews=300');
  const out = promoteNeedsRefetch(queue);
  assert.equal(out.length, queue.length);
  assert.ok(out.indexOf(stuck) < 300);
});

test('cap bounds spend and the draw rotates between runs', () => {
  const queue = Array.from({ length: 60 }, (_, i) => ({ reviewId: `s/${i}.json`, priority: 2, _needsRefetch: true }));
  queue.push({ reviewId: 'plain', priority: 1 });
  const snapshot = queue.map(r => r.reviewId);
  const pick = (seed) => promoteNeedsRefetch(queue, 10, seed).slice(0, 10).map(r => r.reviewId);
  const a = pick(1), b = pick(2);
  assert.equal(a.length, 10);
  assert.notDeepEqual(a, b, 'a different run draws different reviews');
  assert.deepEqual(pick(1), a, 'same run is deterministic');
  // every candidate is reached within a bounded number of runs
  const seen = new Set();
  for (let seed = 0; seed < 40; seed++) pick(seed).forEach(id => seen.add(id));
  assert.equal(seen.size, 60, 'no review is starved');
  assert.equal(promoteNeedsRefetch(queue, 10, 1).length, queue.length);
  assert.deepEqual(queue.map(r => r.reviewId), snapshot, 'input untouched');
  assert.equal(promoteNeedsRefetch(queue, 0, 1).length, queue.length);
  assert.ok(NEEDS_REFETCH_DRAIN_PER_RUN > 0 && NEEDS_REFETCH_DRAIN_PER_RUN <= 50);
});

test('dead or protected reviews never take a drain slot', () => {
  const { isNeedsRefetchDrainCandidate } = require('./collection-priority.js');
  const base = { needsRefetch: true };
  assert.equal(isNeedsRefetchDrainCandidate(base, null), true);
  assert.equal(isNeedsRefetchDrainCandidate(base, { failureCount: 2 }), true);
  assert.equal(isNeedsRefetchDrainCandidate(base, { failureCount: 48 }), false, 'url_dead_404 x48');
  assert.equal(isNeedsRefetchDrainCandidate({ ...base, fetchAttempts: [1, 2, 3] }, null), false);
  assert.equal(isNeedsRefetchDrainCandidate({ ...base, _locked: true }, null), false);
  assert.equal(isNeedsRefetchDrainCandidate({ ...base, manualContentTier: 'complete' }, null), false);
  assert.equal(isNeedsRefetchDrainCandidate({ needsRefetch: true, fullText: 'x'.repeat(900) }, null), false);
});
