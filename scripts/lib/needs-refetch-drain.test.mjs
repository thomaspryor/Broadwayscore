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

test('cap bounds spend, cheapest tier first, input untouched', () => {
  const mk = (id, priority) => ({ reviewId: id, priority, _needsRefetch: true });
  const queue = [mk('a', 3), mk('b', 1), mk('c', 2), { reviewId: 'plain', priority: 1 }];
  const snapshot = queue.map(r => r.reviewId);
  const out = promoteNeedsRefetch(queue, 2);
  assert.deepEqual(out.map(r => r.reviewId), ['b', 'c', 'a', 'plain']);
  assert.deepEqual(queue.map(r => r.reviewId), snapshot);
  assert.equal(promoteNeedsRefetch(queue, 0).length, 4);
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
