// The alert-router deadman fires on "the MOST RECENT attempt failed", but its
// title used to claim "has been silently failing for 7 days" unconditionally.
// On 2026-08-31 that paged the owner with a 7-day subject for a ~12h-old
// breakage. These assert the reported span tracks the ACTUAL failure streak.
//
// Requires the real function (CLAUDE.md §15) — restating the arithmetic here
// would pass even if health-check.js stopped using it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeFailureStreak } = require('../../scripts/lib/alert-dispatch-streak.js');

const NOW = Date.parse('2026-08-31T14:30:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();

test('reports the real span, not a hardcoded 7 days (the 2026-08-31 case)', () => {
  // Reproduces the shape of data/audit/alert-router-attempts.jsonl that day:
  // a week of successes, then 7 LINEAR_API_KEY failures starting ~12h earlier.
  const attempts = [
    { ts: hoursAgo(150), ok: true },
    { ts: hoursAgo(100), ok: true },
    { ts: hoursAgo(12.4), ok: false },
    { ts: hoursAgo(12.4), ok: false },
    { ts: hoursAgo(4.3), ok: false },
  ];
  const { consecutiveFailures, forHowLong } = summarizeFailureStreak(attempts, NOW);
  assert.equal(consecutiveFailures, 3);
  assert.equal(forHowLong, '12h');
  assert.notEqual(forHowLong, '7 days');
});

test('an interleaved success ends the streak — only the tail counts', () => {
  const attempts = [
    { ts: hoursAgo(80), ok: false },
    { ts: hoursAgo(70), ok: false },
    { ts: hoursAgo(60), ok: true },
    { ts: hoursAgo(3), ok: false },
  ];
  const { consecutiveFailures, forHowLong } = summarizeFailureStreak(attempts, NOW);
  assert.equal(consecutiveFailures, 1, 'the older failures are not part of the current streak');
  assert.equal(forHowLong, '3h');
});

test('a genuinely long outage still reads in days', () => {
  const attempts = [
    { ts: hoursAgo(200), ok: true },
    { ts: hoursAgo(170), ok: false },
    { ts: hoursAgo(2), ok: false },
  ];
  assert.equal(summarizeFailureStreak(attempts, NOW).forHowLong, '7 days');
});

test('sub-hour and no-streak cases do not render odd spans', () => {
  assert.equal(summarizeFailureStreak([{ ts: hoursAgo(0.2), ok: false }], NOW).forHowLong, '<1h');
  const none = summarizeFailureStreak([{ ts: hoursAgo(5), ok: true }], NOW);
  assert.equal(none.consecutiveFailures, 0);
});

test('empty and malformed input never renders NaN into an owner-facing subject', () => {
  assert.equal(summarizeFailureStreak([], NOW).consecutiveFailures, 0);
  assert.equal(summarizeFailureStreak(undefined, NOW).consecutiveFailures, 0);
  const bad = summarizeFailureStreak([{ ts: 'not-a-date', ok: false }], NOW);
  assert.equal(bad.consecutiveFailures, 1);
  assert.ok(!/NaN/.test(bad.forHowLong), `rendered "${bad.forHowLong}"`);
});
