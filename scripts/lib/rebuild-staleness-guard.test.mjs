// Unit tests for scripts/lib/rebuild-staleness-guard.js — the stale-checkout
// race where a review-texts push lands between the rebuild job's checkout
// step and the "Rebuild reviews.json" step, so the rebuild exits 0 but
// silently omits a show that had scoreable content on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRetryForStaleCheckout, findMissingScoreableShows } = require('./rebuild-staleness-guard.js');

test('shouldRetryForStaleCheckout: SHA changed during the job triggers a retry', () => {
  assert.equal(shouldRetryForStaleCheckout('abc123', 'def456'), true);
});

test('shouldRetryForStaleCheckout: unchanged SHA never triggers extra rebuild cost', () => {
  assert.equal(shouldRetryForStaleCheckout('abc123', 'abc123'), false);
});

test('shouldRetryForStaleCheckout: missing/empty SHA fails closed (no retry on bad input)', () => {
  assert.equal(shouldRetryForStaleCheckout('', 'def456'), false);
  assert.equal(shouldRetryForStaleCheckout('abc123', ''), false);
  assert.equal(shouldRetryForStaleCheckout(null, null), false);
  assert.equal(shouldRetryForStaleCheckout(undefined, 'def456'), false);
});

test('findMissingScoreableShows: a scoreable show with zero reviews.json entries is reported', () => {
  const missing = findMissingScoreableShows(['show-a', 'show-b'], ['show-a']);
  assert.deepEqual(missing, ['show-b']);
});

test('findMissingScoreableShows: every scoreable show already present → empty (job stays green)', () => {
  const missing = findMissingScoreableShows(['show-a', 'show-b'], ['show-a', 'show-b', 'show-c']);
  assert.deepEqual(missing, []);
});

test('findMissingScoreableShows: no scoreable candidates → empty regardless of reviews.json', () => {
  assert.deepEqual(findMissingScoreableShows([], []), []);
  assert.deepEqual(findMissingScoreableShows([], ['show-a']), []);
});

test('findMissingScoreableShows: dedupes and sorts', () => {
  const missing = findMissingScoreableShows(['show-c', 'show-a', 'show-a'], []);
  assert.deepEqual(missing, ['show-a', 'show-c']);
});
