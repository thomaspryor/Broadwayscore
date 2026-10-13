import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { clearFailureFlags } = require('./clear-failure-flags.js');

const longText = 'x'.repeat(800);
// A long-but-not-complete fetch that already carries a score: the shape that
// let the generic stale-clear rule null a freshly set reason (BRO-2241).
const fresh = () => ({
  contentTier: 'excerpt',
  fullText: longText,
  aggregatorStars: 4,
  incompleteReason: 'scraper_garbage',
  incompleteDetail: 'just classified',
});

test('without the opt-out, a fresh incompleteReason is nulled (legacy behavior)', () => {
  const d = fresh();
  const cleared = clearFailureFlags(d);
  assert.ok(cleared.includes('incompleteReason'));
  assert.equal(d.incompleteReason, null);
});

test('skipIncompleteReasonClear keeps the reason and detail', () => {
  const d = fresh();
  const cleared = clearFailureFlags(d, { skipIncompleteReasonClear: true });
  assert.ok(!cleared.includes('incompleteReason'));
  assert.equal(d.incompleteReason, 'scraper_garbage');
  assert.equal(d.incompleteDetail, 'just classified');
});

test('skipIncompleteReasonClear does not disable the other clear rules', () => {
  const d = { ...fresh(), url: 'https://example.com/a', serpRetryCount: 2, textFetchedAt: 'now', fetchAttempts: 3 };
  const cleared = clearFailureFlags(d, { skipIncompleteReasonClear: true });
  assert.ok(cleared.includes('serpRetryCount'));
  assert.ok(cleared.includes('fetchAttempts'));
  assert.equal(d.incompleteReason, 'scraper_garbage');
});

test('skipRejectionReasonClear still works independently', () => {
  const d = { fullText: longText, rejectionReason: 'garbage_text', rejectedBy: ['a'] };
  clearFailureFlags(d, { skipRejectionReasonClear: true });
  assert.equal(d.rejectionReason, 'garbage_text');
});
