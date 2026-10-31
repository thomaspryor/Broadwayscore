/**
 * Tests for scripts/lib/browserbase-live-usage.js's pure counting logic.
 *
 * countRecentSessions is the part that matters: given a raw Browserbase
 * /v1/sessions response, does it correctly count only sessions created in
 * the trailing window? The network call itself (fetchLiveBrowserbaseSessionsToday)
 * is a thin wrapper and isn't hit here — no live credits consumed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { countRecentSessions, countRecentSessionsForCaller } = require('../../scripts/lib/browserbase-live-usage.js');

const NOW = new Date('2026-07-27T12:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 60 * 60 * 1000).toISOString();

test('counts only sessions within the last 24h (array response shape)', () => {
  const data = [
    { id: '1', createdAt: hoursAgo(1) },
    { id: '2', createdAt: hoursAgo(23) },
    { id: '3', createdAt: hoursAgo(25) }, // outside window
    { id: '4', createdAt: hoursAgo(100) }, // outside window
  ];
  assert.equal(countRecentSessions(data, 24, NOW), 2);
});

test('handles {data: [...]} wrapper response shape', () => {
  const data = { data: [{ id: '1', createdAt: hoursAgo(2) }, { id: '2', createdAt: hoursAgo(2) }] };
  assert.equal(countRecentSessions(data, 24, NOW), 2);
});

test('returns 0 for empty session list', () => {
  assert.equal(countRecentSessions([], 24, NOW), 0);
});

test('ignores malformed entries (missing createdAt, null)', () => {
  const data = [null, {}, { id: '1' }, { id: '2', createdAt: hoursAgo(1) }];
  assert.equal(countRecentSessions(data, 24, NOW), 1);
});

test('respects a custom hours window', () => {
  const data = [{ id: '1', createdAt: hoursAgo(0.5) }, { id: '2', createdAt: hoursAgo(2) }];
  assert.equal(countRecentSessions(data, 1, NOW), 1);
});

test('countRecentSessionsForCaller counts only this caller within the window', () => {
  const data = [
    { id: '1', createdAt: hoursAgo(1), userMetadata: { caller: 'probe-a.js' } },
    { id: '2', createdAt: hoursAgo(2), userMetadata: { caller: 'probe-a.js' } },
    { id: '3', createdAt: hoursAgo(3), userMetadata: { caller: 'other.js' } },
    { id: '4', createdAt: hoursAgo(30), userMetadata: { caller: 'probe-a.js' } }, // outside window
  ];
  assert.equal(countRecentSessionsForCaller(data, 'probe-a.js', 24, NOW), 2);
  assert.equal(countRecentSessionsForCaller({ data }, 'none.js', 24, NOW), 0);
});

test('countRecentSessionsForCaller returns null (unknown) when the list carries no userMetadata', () => {
  const data = [{ id: '1', createdAt: hoursAgo(1) }, { id: '2', createdAt: hoursAgo(2) }];
  assert.equal(countRecentSessionsForCaller(data, 'probe-a.js', 24, NOW), null);
});

test('countRecentSessionsForCaller is 0 for an empty list', () => {
  assert.equal(countRecentSessionsForCaller([], 'probe-a.js', 24, NOW), 0);
});
