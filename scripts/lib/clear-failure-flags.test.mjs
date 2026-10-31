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
  incompleteReason: 'partial_text',
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
  assert.equal(d.incompleteReason, 'partial_text');
  assert.equal(d.incompleteDetail, 'just classified');
});

test('skipIncompleteReasonClear does not disable the other clear rules', () => {
  const d = { ...fresh(), url: 'https://example.com/a', serpRetryCount: 2, textFetchedAt: 'now', fetchAttempts: 3 };
  const cleared = clearFailureFlags(d, { skipIncompleteReasonClear: true });
  assert.ok(cleared.includes('serpRetryCount'));
  assert.ok(cleared.includes('fetchAttempts'));
  assert.equal(d.incompleteReason, 'partial_text');
});

test('skipRejectionReasonClear still works independently', () => {
  const d = { fullText: longText, rejectionReason: 'garbage_text', rejectedBy: ['a'] };
  clearFailureFlags(d, { skipRejectionReasonClear: true });
  assert.equal(d.rejectionReason, 'garbage_text');
});

test('skipIncompleteReasonClear also keeps wrong_content and no_url reasons', () => {
  const a = { ...fresh(), incompleteReason: 'wrong_content', contentTier: 'complete' };
  clearFailureFlags(a, { skipIncompleteReasonClear: true });
  assert.equal(a.incompleteReason, 'wrong_content');
  const b = { ...fresh(), incompleteReason: 'no_url', url: 'https://example.com/a' };
  clearFailureFlags(b, { skipIncompleteReasonClear: true });
  assert.equal(b.incompleteReason, 'no_url');
});

// The collector's success path re-derives incompleteReason right before this
// call, so it must pass the skip; without it the fresh reason self-nulls
// (BRO-2241). updateReviewJson is not exported, so pin the call site.
test('collect-review-texts success path re-derives the reason and skips the generic clear', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /applyIncompleteReason\(data, null\);[\s\S]{0,600}clearFailureFlags\(data, \{ skipIncompleteReasonClear: true \}\)/);
});
