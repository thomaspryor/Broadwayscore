/**
 * Regression test for #926: gather-reviews.js was triggering a full
 * rebuild-all-reviews.js pass even when zero shows were processed/collected
 * (e.g. a mistyped --shows= id). shouldTriggerRebuild() is the pure gate
 * wired into gather-reviews.js main() to skip that no-op rebuild.
 *
 * Run: node --test tests/unit/gather-reviews-rebuild-trigger.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldTriggerRebuild } = require('../../scripts/lib/gather-reviews-rebuild-trigger.js');

test('0 collected across all shows → no rebuild', () => {
  const results = [
    { showId: 'nonexistent-show-id-zzz999', success: false, error: 'Show not found' },
  ];
  assert.equal(shouldTriggerRebuild(results), false);
});

test('all shows created 0 files → no rebuild', () => {
  const results = [
    { showId: 'show-a', success: true, filesCreated: 0 },
    { showId: 'show-b', success: true, filesCreated: 0 },
  ];
  assert.equal(shouldTriggerRebuild(results), false);
});

test('>0 collected → rebuild triggered', () => {
  const results = [
    { showId: 'show-a', success: true, filesCreated: 0 },
    { showId: 'show-b', success: true, filesCreated: 2 },
  ];
  assert.equal(shouldTriggerRebuild(results), true);
});

test('empty results array → no rebuild', () => {
  assert.equal(shouldTriggerRebuild([]), false);
});

test('non-array input → no rebuild', () => {
  assert.equal(shouldTriggerRebuild(undefined), false);
  assert.equal(shouldTriggerRebuild(null), false);
});
