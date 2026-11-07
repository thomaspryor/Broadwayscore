import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  SETTLE_HOURS, CLEAR_REPORT_HOURS, LEGACY_SEED, updateFirstSeen, isSettling, reportableCleared, ageHours,
} = require('./health-first-seen.js');

const T0 = '2026-11-04T12:00:00.000Z';
const T1 = '2026-11-05T12:00:00.000Z';
const T2 = '2026-11-06T12:00:00.000Z';
const T3 = '2026-11-07T12:00:00.000Z';
const w = (name) => ({ name, status: 'warn' });
const e = (name) => ({ name, status: 'error' });
const p = (name) => ({ name, status: 'pass' });

test('bootstrap (no firstSeen yet) seeds open rows as legacy so nothing is hidden', () => {
  const r = updateFirstSeen({ results: [] }, [w('A'), p('B')], T0);
  assert.equal(r.firstSeen.A, LEGACY_SEED);
  assert.equal(r.firstSeen.B, undefined);
  assert.equal(isSettling({ firstSeen: r.firstSeen.A }, 'warn', Date.parse(T0)), false);
});

test('a new warning gets today as first seen and keeps it on later runs', () => {
  let s = updateFirstSeen({ firstSeen: {} }, [w('A')], T0);
  assert.equal(s.firstSeen.A, T0);
  s = updateFirstSeen(s, [w('A')], T1);
  assert.equal(s.firstSeen.A, T0);
});

test('a warning is held for 48h, errors never are', () => {
  const now = Date.parse(T1);
  assert.equal(isSettling({ firstSeen: T0 }, 'warn', now), true);
  assert.equal(isSettling({ firstSeen: T0 }, 'error', now), false);
  assert.equal(isSettling({ firstSeen: T0 }, 'warn', Date.parse(T2)), false);
  assert.equal(SETTLE_HOURS, 48);
});

test('unknown or unparseable age is shown (fail-safe)', () => {
  const now = Date.parse(T1);
  assert.equal(isSettling({}, 'warn', now), false);
  assert.equal(isSettling({ firstSeen: 'garbage' }, 'warn', now), false);
  assert.equal(isSettling(null, 'warn', now), false);
  assert.equal(ageHours(undefined, now), null);
});

test('a row that clears is recorded; a short-lived warning is not reportable', () => {
  let s = updateFirstSeen({ firstSeen: {} }, [w('A'), w('B')], T0);
  s = updateFirstSeen(s, [w('B')], T1);
  assert.ok(s.cleared.A);
  assert.deepEqual(reportableCleared(s.cleared, Date.parse(T1)), []); // 24h warning was never shown
});

test('a warning that outlasted the hold is reportable when it clears; errors always are', () => {
  let s = updateFirstSeen({ firstSeen: {} }, [w('A'), e('E')], T0);
  s = updateFirstSeen(s, [w('A'), e('E')], T2);
  s = updateFirstSeen(s, [p('A'), p('E')], T3);
  const names = reportableCleared(s.cleared, Date.parse(T3)).map((x) => x.name).sort();
  assert.deepEqual(names, ['A', 'E']);
});

test('a row that flaps back within a week keeps its original clock', () => {
  let s = updateFirstSeen({ firstSeen: {} }, [w('A')], T0);
  s = updateFirstSeen(s, [], T2);       // cleared at T2
  s = updateFirstSeen(s, [w('A')], T3); // back 24h later
  assert.equal(s.firstSeen.A, T0);
  assert.equal(s.cleared.A, undefined);
});

test('a row that returns after the keep window starts a fresh clock', () => {
  let s = updateFirstSeen({ firstSeen: {} }, [w('A')], T0);
  s = updateFirstSeen(s, [], T1);
  const later = '2026-11-20T12:00:00.000Z';
  s = updateFirstSeen(s, [w('A')], later);
  assert.equal(s.firstSeen.A, later);
});

test('cleared entries expire after the keep window', () => {
  let s = updateFirstSeen({ firstSeen: {} }, [w('A')], T0);
  s = updateFirstSeen(s, [], T1);
  assert.ok(s.cleared.A);
  s = updateFirstSeen(s, [], '2026-11-20T12:00:00.000Z');
  assert.equal(s.cleared.A, undefined);
});

test('garbage input does not throw', () => {
  assert.doesNotThrow(() => updateFirstSeen(null, null, T0));
  assert.doesNotThrow(() => updateFirstSeen({ firstSeen: null, cleared: 5 }, [null, {}], T0));
});

test('cleared rows keep their error status through the stored openStatus map (as health-check.js saves it)', () => {
  const hist = { firstSeen: {}, openStatus: {} };
  let s = updateFirstSeen(hist, [e('E')], T0);
  hist.firstSeen = s.firstSeen; hist.openStatus = s.openStatus;
  s = updateFirstSeen(hist, [p('E')], T1);
  assert.equal(s.cleared.E.status, 'error');
  assert.deepEqual(reportableCleared(s.cleared, Date.parse(T1)).map((x) => x.name), ['E']); // a 24h-old error was shown
});

test('"Cleared since yesterday" drops a row after CLEAR_REPORT_HOURS', () => {
  const hist = { firstSeen: {}, openStatus: {} };
  let s = updateFirstSeen(hist, [e('E')], T0);
  hist.firstSeen = s.firstSeen; hist.openStatus = s.openStatus;
  s = updateFirstSeen(hist, [], T1);
  assert.equal(reportableCleared(s.cleared, Date.parse(T1) + (CLEAR_REPORT_HOURS - 1) * 3600e3).length, 1);
  assert.equal(reportableCleared(s.cleared, Date.parse(T1) + (CLEAR_REPORT_HOURS + 1) * 3600e3).length, 0);
});
