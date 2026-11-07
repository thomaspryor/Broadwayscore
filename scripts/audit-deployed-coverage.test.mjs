import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectDeployedCoverageTargets } = require('./lib/deployed-coverage-targets.js');

// 2026-07-30T12:00:00Z is mid-afternoon ET on 2026-07-30 — nowhere near the
// UTC/ET day boundary, used as the baseline "now" for non-boundary cases.
const NOW_MS = Date.parse('2026-07-30T12:00:00.000Z');

function show(overrides = {}) {
  return { id: 'test-show', status: 'closed', openingDate: null, ...overrides };
}

test('opened-and-recent show is included', () => {
  const shows = [show({ id: 'recent', status: 'closed', openingDate: '2026-07-20' })];
  const targets = selectDeployedCoverageTargets(shows, { days: 21, nowMs: NOW_MS });
  assert.deepEqual(targets.map((s) => s.id), ['recent']);
});

test('opened-but-too-old show is excluded', () => {
  const shows = [show({ id: 'old', status: 'closed', openingDate: '2026-01-01' })];
  const targets = selectDeployedCoverageTargets(shows, { days: 21, nowMs: NOW_MS });
  assert.deepEqual(targets, []);
});

test('not-yet-opened show is excluded even though it is within the recency window', () => {
  // Card #639: dolly-an-original-musical-2026-style case — openingDate is in
  // the future, so an unopened show cannot structurally have any reviews.
  const shows = [show({ id: 'upcoming', status: 'upcoming', openingDate: '2026-08-15' })];
  const targets = selectDeployedCoverageTargets(shows, { days: 21, nowMs: NOW_MS });
  assert.deepEqual(targets, []);
});

test('status "open" evergreen is included regardless of openingDate age', () => {
  const shows = [show({ id: 'evergreen', status: 'open', openingDate: '2003-01-01' })];
  const targets = selectDeployedCoverageTargets(shows, { days: 21, nowMs: NOW_MS });
  assert.deepEqual(targets.map((s) => s.id), ['evergreen']);
});

test('ET/UTC boundary: a show opening "today" ET is included even when UTC has already rolled over', () => {
  // 2026-07-31T02:30:00Z is 2026-07-30 22:30:00 in America/New_York (UTC-4
  // in July) — UTC has already rolled into the 31st, but it is still the
  // 30th ET. A show that opened "today" ET must not be excluded by a bare
  // toISOString() comparison.
  const nowMs = Date.parse('2026-07-31T02:30:00.000Z');
  const shows = [show({ id: 'todayET', status: 'closed', openingDate: '2026-07-30' })];
  const targets = selectDeployedCoverageTargets(shows, { days: 21, nowMs });
  assert.deepEqual(targets.map((s) => s.id), ['todayET']);
});

test('ET/UTC boundary: a show does not become "opened" 4h early just because UTC rolled over', () => {
  // Same instant as above, but the show's openingDate is the (UTC) 31st —
  // which has not arrived yet in ET. Must be excluded.
  const nowMs = Date.parse('2026-07-31T02:30:00.000Z');
  const shows = [show({ id: 'notYetET', status: 'closed', openingDate: '2026-07-31' })];
  const targets = selectDeployedCoverageTargets(shows, { days: 21, nowMs });
  assert.deepEqual(targets, []);
});
