import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isAgedNonTerminalGap,
  shouldBackstopAlert,
  nonTerminalAgeHours,
  gapFirstSeen,
  BACKSTOP_MIN_AGE_HOURS,
} = require('./t1-backstop.js');

const NOW = new Date('2026-07-22T12:00:00Z');

test('aged fixture (firstSeenAt 30h ago) fires the backstop', () => {
  const file = { firstSeenAt: '2026-07-21T06:00:00Z' }; // 30h before NOW
  assert.equal(isAgedNonTerminalGap({ file, now: NOW }), true);
});

test('fresh file (2h old) does NOT fire', () => {
  const file = { firstSeenAt: '2026-07-22T10:00:00Z' };
  assert.equal(isAgedNonTerminalGap({ file, now: NOW }), false);
});

test('exactly 24h does not fire; just over 24h does', () => {
  assert.equal(isAgedNonTerminalGap({ file: { firstSeenAt: '2026-07-21T12:00:00Z' }, now: NOW }), false);
  assert.equal(isAgedNonTerminalGap({ file: { firstSeenAt: '2026-07-21T11:59:00Z' }, now: NOW }), true);
});

test('falls back to collectedAt / textFetchedAt / rejectedAt when firstSeenAt absent', () => {
  assert.equal(gapFirstSeen({ collectedAt: '2026-07-20T00:00:00Z' }), '2026-07-20T00:00:00Z');
  assert.equal(gapFirstSeen({ textFetchedAt: '2026-07-20T00:00:00Z' }), '2026-07-20T00:00:00Z');
  assert.equal(gapFirstSeen({ rejectedAt: '2026-07-20T00:00:00Z' }), '2026-07-20T00:00:00Z');
  assert.equal(isAgedNonTerminalGap({ file: { collectedAt: '2026-07-20T00:00:00Z' }, now: NOW }), true);
});

test('firstSeenAt WINS over other stamps (immutable creation time)', () => {
  const file = { firstSeenAt: '2026-07-21T06:00:00Z', collectedAt: '2026-07-22T11:00:00Z' };
  assert.equal(gapFirstSeen(file), '2026-07-21T06:00:00Z');
});

test('no usable timestamp → does NOT fire (cannot prove >24h)', () => {
  assert.equal(nonTerminalAgeHours({}, NOW), null);
  assert.equal(isAgedNonTerminalGap({ file: {}, now: NOW }), false);
  assert.equal(isAgedNonTerminalGap({ file: { firstSeenAt: 'not-a-date' }, now: NOW }), false);
});

test('dedupe: aged fixture fires once, second run within window dedupes', () => {
  // First run: never alerted → fire.
  assert.equal(shouldBackstopAlert(null, NOW), true);
  // Second run same day: already alerted → dedupe.
  assert.equal(shouldBackstopAlert('2026-07-22T00:00:00Z', NOW), false);
  // After the re-alert window: fire again.
  assert.equal(shouldBackstopAlert('2026-07-10T00:00:00Z', NOW), true);
  // Unparseable stamp → fail loud (re-alert).
  assert.equal(shouldBackstopAlert('garbage', NOW), true);
});

test('threshold constant is 24h', () => {
  assert.equal(BACKSTOP_MIN_AGE_HOURS, 24);
});
