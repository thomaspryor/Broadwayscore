import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasScoredReviews } = require('./scoring-progress-gate.js');

test('all-rejected batch (processed=0, filesModified>0) returns true', () => {
  // Reproduces the orphan-unscored-wp-cleared-2026-04-29 batch: 19 files hit
  // rejection branches, zero scored, but every rejection wrote state to disk.
  assert.equal(hasScoredReviews({ processed: 0, filesModified: 19, skipped: 19 }), true);
});

test('genuinely nothing happened (all counters zero) returns false', () => {
  assert.equal(hasScoredReviews({ processed: 0, filesModified: 0, skipped: 0 }), false);
});

test('garbage-only skip batch with no disk writes returns false', () => {
  // Reviews skipped for insufficient text never reach saveReviewFile().
  assert.equal(hasScoredReviews({ processed: 0, filesModified: 0, skipped: 12 }), false);
});

test('normal mixed batch (some scored, some rejected) returns true', () => {
  assert.equal(hasScoredReviews({ processed: 40, filesModified: 50, skipped: 10 }), true);
});

test('legacy progress file without filesModified falls back to processed', () => {
  assert.equal(hasScoredReviews({ processed: 5, skipped: 2 }), true);
  assert.equal(hasScoredReviews({ processed: 0, skipped: 2 }), false);
});

test('missing or malformed progress returns false', () => {
  assert.equal(hasScoredReviews(null), false);
  assert.equal(hasScoredReviews(undefined), false);
  assert.equal(hasScoredReviews({}), false);
  assert.equal(hasScoredReviews('not an object'), false);
});
