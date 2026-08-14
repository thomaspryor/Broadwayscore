// Card #1456: new shows go live fully scored with NO artwork for up to 3.5
// days. Exercises the pure decision functions the show-publish dispatch path
// and the imageless-scored-show audit both call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildImageDispatchInputs, findImagelessScoredShows } = require('../../scripts/lib/image-trigger-guard.js');

test('buildImageDispatchInputs sets show_id per id, dedupes, trims, drops empties', () => {
  const dispatches = buildImageDispatchInputs(['show-a', ' show-b ', 'show-a', '', null, undefined]);
  assert.deepEqual(dispatches, [
    { workflow_id: 'fetch-all-image-formats.yml', inputs: { show_id: 'show-a', only_missing: 'true' } },
    { workflow_id: 'fetch-all-image-formats.yml', inputs: { show_id: 'show-b', only_missing: 'true' } },
  ]);
});

test('buildImageDispatchInputs returns [] for no ids', () => {
  assert.deepEqual(buildImageDispatchInputs([]), []);
  assert.deepEqual(buildImageDispatchInputs(undefined), []);
});

test('findImagelessScoredShows flags a scored show past the threshold with no image', () => {
  const nowMs = Date.parse('2026-08-14T00:00:00Z');
  const shows = [{
    id: 'game-of-thrones-the-mad-king-regional-2026',
    title: 'Game of Thrones: The Mad King',
    hasImages: false,
    reviewCount: 3,
    sinceMs: Date.parse('2026-08-11T00:00:00Z'), // 72h ago
  }];
  const flagged = findImagelessScoredShows(shows, { nowMs, thresholdHours: 24 });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, 'game-of-thrones-the-mad-king-regional-2026');
});

test('findImagelessScoredShows does not flag a show still inside the grace window', () => {
  const nowMs = Date.parse('2026-08-14T00:00:00Z');
  const shows = [{
    id: 'fresh-show-2026',
    hasImages: false,
    reviewCount: 3,
    sinceMs: Date.parse('2026-08-13T12:00:00Z'), // 12h ago, threshold is 24h
  }];
  assert.deepEqual(findImagelessScoredShows(shows, { nowMs, thresholdHours: 24 }), []);
});

test('findImagelessScoredShows does not flag a show that already has an image', () => {
  const nowMs = Date.parse('2026-08-14T00:00:00Z');
  const shows = [{
    id: 'has-poster-2026',
    hasImages: true,
    reviewCount: 5,
    sinceMs: Date.parse('2026-08-01T00:00:00Z'),
  }];
  assert.deepEqual(findImagelessScoredShows(shows, { nowMs, thresholdHours: 24 }), []);
});

test('findImagelessScoredShows does not flag an unscored show (reviewCount 0)', () => {
  const nowMs = Date.parse('2026-08-14T00:00:00Z');
  const shows = [{
    id: 'unscored-2026',
    hasImages: false,
    reviewCount: 0,
    sinceMs: Date.parse('2026-08-01T00:00:00Z'),
  }];
  assert.deepEqual(findImagelessScoredShows(shows, { nowMs, thresholdHours: 24 }), []);
});

test('findImagelessScoredShows skips shows with no resolvable timestamp', () => {
  const nowMs = Date.parse('2026-08-14T00:00:00Z');
  const shows = [{ id: 'no-date-2026', hasImages: false, reviewCount: 2, sinceMs: null }];
  assert.deepEqual(findImagelessScoredShows(shows, { nowMs, thresholdHours: 24 }), []);
});
