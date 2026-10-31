import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isFreshPulse, MAX_SOCIAL_PULSE_AGE_DAYS } from '../../src/lib/data-social-pulse';

// Fixed reference "now" so the test is deterministic regardless of run date.
const NOW = new Date('2026-05-30T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

test('fresh fetch within the window is fresh', () => {
  assert.equal(isFreshPulse(daysAgo(3), NOW), true);
  assert.equal(isFreshPulse(daysAgo(0), NOW), true);
});

test('boundary: exactly MAX_SOCIAL_PULSE_AGE_DAYS is still fresh, just over is stale', () => {
  assert.equal(isFreshPulse(daysAgo(MAX_SOCIAL_PULSE_AGE_DAYS), NOW), true);
  // 1 second past the window
  const justOver = new Date(NOW.getTime() - (MAX_SOCIAL_PULSE_AGE_DAYS * 24 * 60 * 60 * 1000 + 1000)).toISOString();
  assert.equal(isFreshPulse(justOver, NOW), false);
});

test('stale fetch beyond the window is stale', () => {
  assert.equal(isFreshPulse(daysAgo(20), NOW), false);
});

test('missing / unparseable timestamps are treated as stale (safe direction)', () => {
  assert.equal(isFreshPulse(null, NOW), false);
  assert.equal(isFreshPulse(undefined, NOW), false);
  assert.equal(isFreshPulse('', NOW), false);
  assert.equal(isFreshPulse('not-a-date', NOW), false);
});

test('School Girls incident: 2026-04-13 fetch is stale as of 2026-05-30', () => {
  // The actual frozen timestamp from public/data/shows/school-girls-...social.json
  assert.equal(isFreshPulse('2026-04-13T17:21:15.365Z', NOW), false);
});

test('a current weekly fetch (2026-05-27) is fresh as of 2026-05-30', () => {
  assert.equal(isFreshPulse('2026-05-27T08:51:23.308Z', NOW), true);
});
