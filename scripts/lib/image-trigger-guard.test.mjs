// BRO-2672: image-trigger-guard.js pure-function tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildImageDispatchInputs,
  findImagelessScoredShows,
  DEFAULT_THRESHOLD_HOURS,
} = require('./image-trigger-guard.js');

test('buildImageDispatchInputs batches N shows into ONE dispatch, not N', () => {
  // Mirrors the real incident: 6 shows promoted together fired 6 separate
  // workflow_dispatch calls into a single-slot concurrency group
  // (cancel-in-progress: false) and 5 of them were silently CANCELLED.
  // A single dispatch carrying all 6 ids cannot be cancelled by its own
  // siblings, so exactly one dispatch entry must come back regardless of N.
  const showIds = ['show-a', 'show-b', 'show-c', 'show-d', 'show-e', 'show-f'];
  const dispatches = buildImageDispatchInputs(showIds);

  assert.equal(dispatches.length, 1, 'must fan into exactly one dispatch, not one per show');
  assert.equal(dispatches[0].workflow_id, 'fetch-all-image-formats.yml');
  assert.equal(dispatches[0].inputs.show_id, showIds.join(','));
  assert.equal(dispatches[0].inputs.only_missing, 'true');
});

test('buildImageDispatchInputs dedupes ids within the single dispatch', () => {
  const dispatches = buildImageDispatchInputs(['a', 'b', 'a', 'b', 'c']);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].inputs.show_id, 'a,b,c');
});

test('buildImageDispatchInputs trims whitespace and drops empty/non-string entries', () => {
  const dispatches = buildImageDispatchInputs([' show-a ', '', null, undefined, 'show-b']);
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].inputs.show_id, 'show-a,show-b');
});

test('buildImageDispatchInputs returns no dispatch for an empty/missing list', () => {
  assert.deepEqual(buildImageDispatchInputs([]), []);
  assert.deepEqual(buildImageDispatchInputs(undefined), []);
  assert.deepEqual(buildImageDispatchInputs(['', '   ', null]), []);
});

test('findImagelessScoredShows flags reviewed shows past the threshold with no image', () => {
  const nowMs = Date.parse('2026-08-31T00:00:00Z');
  const staleMs = nowMs - (DEFAULT_THRESHOLD_HOURS + 1) * 3600 * 1000;
  const freshMs = nowMs - 1 * 3600 * 1000;

  const shows = [
    { id: 'stale-no-image', hasImages: false, reviewCount: 3, sinceMs: staleMs },
    { id: 'stale-has-image', hasImages: true, reviewCount: 3, sinceMs: staleMs },
    { id: 'stale-no-reviews', hasImages: false, reviewCount: 0, sinceMs: staleMs },
    { id: 'fresh-no-image', hasImages: false, reviewCount: 3, sinceMs: freshMs },
    { id: 'unresolvable-since', hasImages: false, reviewCount: 3, sinceMs: null },
  ];

  const flagged = findImagelessScoredShows(shows, { nowMs });
  assert.deepEqual(flagged.map((s) => s.id), ['stale-no-image']);
});

test('findImagelessScoredShows respects a custom thresholdHours', () => {
  const nowMs = Date.parse('2026-08-31T00:00:00Z');
  const show = { id: 'x', hasImages: false, reviewCount: 1, sinceMs: nowMs - 2 * 3600 * 1000 };
  assert.deepEqual(findImagelessScoredShows([show], { nowMs, thresholdHours: 24 }), []);
  assert.deepEqual(findImagelessScoredShows([show], { nowMs, thresholdHours: 1 }).map((s) => s.id), ['x']);
});
