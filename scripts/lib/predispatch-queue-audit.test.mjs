import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tallyVerdicts, findWeekAgoEntry, buildQueueAuditSnapshot, JUMP_THRESHOLD_PCT,
} from './predispatch-queue-audit.js';

const DAY_MS = 24 * 3600e3;
const NOW = new Date('2026-08-19T12:00:00Z').getTime();

test('tallyVerdicts: counts each verdict, unresolved for null/unknown', () => {
  const tally = tallyVerdicts([
    { verdict: 'OK-TO-DISPATCH' },
    { verdict: 'OK-TO-DISPATCH' },
    { verdict: 'CHECK-FIRST' },
    { verdict: 'REOPEN-SUSPECT' },
    { verdict: 'DO-NOT-DISPATCH' },
    { verdict: 'DO-NOT-DISPATCH' },
    null,
    { verdict: 'SOMETHING-UNKNOWN' },
  ]);
  assert.equal(tally['OK-TO-DISPATCH'], 2);
  assert.equal(tally['CHECK-FIRST'], 1);
  assert.equal(tally['REOPEN-SUSPECT'], 1);
  assert.equal(tally['DO-NOT-DISPATCH'], 2);
  assert.equal(tally.unresolved, 2);
  assert.equal(tally.total, 8);
});

test('tallyVerdicts: empty/undefined input tallies to all zeros', () => {
  assert.deepEqual(tallyVerdicts([]), {
    'OK-TO-DISPATCH': 0, 'CHECK-FIRST': 0, 'REOPEN-SUSPECT': 0, 'DO-NOT-DISPATCH': 0, unresolved: 0, total: 0,
  });
  assert.deepEqual(tallyVerdicts(undefined), {
    'OK-TO-DISPATCH': 0, 'CHECK-FIRST': 0, 'REOPEN-SUSPECT': 0, 'DO-NOT-DISPATCH': 0, unresolved: 0, total: 0,
  });
});

test('findWeekAgoEntry: picks the entry closest to 7 days old within the 5-9 day window', () => {
  const history = [
    { at: new Date(NOW - 1 * DAY_MS).toISOString(), blockedCount: 10 }, // too recent
    { at: new Date(NOW - 6 * DAY_MS).toISOString(), blockedCount: 20 }, // in window, further from 7d
    { at: new Date(NOW - 7.2 * DAY_MS).toISOString(), blockedCount: 30 }, // closest to 7d
    { at: new Date(NOW - 20 * DAY_MS).toISOString(), blockedCount: 5 }, // too old
  ];
  const best = findWeekAgoEntry(history, NOW);
  assert.equal(best.blockedCount, 30);
});

test('findWeekAgoEntry: no entries in the 5-9 day window returns null', () => {
  const history = [
    { at: new Date(NOW - 1 * DAY_MS).toISOString(), blockedCount: 10 },
    { at: new Date(NOW - 30 * DAY_MS).toISOString(), blockedCount: 20 },
  ];
  assert.equal(findWeekAgoEntry(history, NOW), null);
  assert.equal(findWeekAgoEntry([], NOW), null);
  assert.equal(findWeekAgoEntry(undefined, NOW), null);
});

test('findWeekAgoEntry: malformed entries are skipped, not thrown on', () => {
  const history = [
    null,
    { at: 'not-a-date', blockedCount: 5 },
    { blockedCount: 5 }, // missing at
    { at: new Date(NOW - 3600e3).toISOString() }, // missing blockedCount
    { at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 40 },
  ];
  const best = findWeekAgoEntry(history, NOW);
  assert.equal(best.blockedCount, 40);
});

test('buildQueueAuditSnapshot: steady state (no history) reports plain count, no jump', () => {
  const classifications = [
    ...Array(20).fill({ verdict: 'OK-TO-DISPATCH' }),
    ...Array(5).fill({ verdict: 'CHECK-FIRST' }),
    ...Array(3).fill({ verdict: 'REOPEN-SUSPECT' }),
    ...Array(2).fill({ verdict: 'DO-NOT-DISPATCH' }),
  ];
  const snap = buildQueueAuditSnapshot({ classifications, history: [], now: NOW });
  assert.equal(snap.blockedCount, 5); // 3 reopen-suspect + 2 do-not-dispatch
  assert.equal(snap.jump, null);
  assert.match(snap.bannerText, /5 of 30 queued cards blocked from auto-dispatch/);
  assert.match(snap.bannerText, /3 reopen-suspect, 2 do-not-dispatch/);
  assert.ok(!snap.bannerText.includes('⚠'));
  assert.equal(snap.generatedAt, new Date(NOW).toISOString());
  assert.equal(snap.items.length, 4);
});

test('buildQueueAuditSnapshot: a real week-over-week jump above threshold is flagged', () => {
  const classifications = [
    ...Array(10).fill({ verdict: 'OK-TO-DISPATCH' }),
    ...Array(20).fill({ verdict: 'REOPEN-SUSPECT' }), // blockedCount jumps to 20 from 10 = +100%
  ];
  const history = [
    { at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 10 },
  ];
  const snap = buildQueueAuditSnapshot({ classifications, history, now: NOW });
  assert.ok(snap.jump, 'expected a jump to be flagged');
  assert.equal(snap.jump.previousCount, 10);
  assert.ok(snap.jump.pctChange >= JUMP_THRESHOLD_PCT);
  assert.match(snap.bannerText, /^⚠ blocked backlog jumped to 20/);
});

test('buildQueueAuditSnapshot: normal steady-state fluctuation under threshold does not alert (30-ish is normal per card body)', () => {
  const classifications = [
    ...Array(50).fill({ verdict: 'OK-TO-DISPATCH' }),
    ...Array(16).fill({ verdict: 'REOPEN-SUSPECT' }),
    ...Array(16).fill({ verdict: 'DO-NOT-DISPATCH' }), // blockedCount = 32, +6.7% over 30
  ];
  const history = [
    { at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 30 },
  ];
  const snap = buildQueueAuditSnapshot({ classifications, history, now: NOW });
  assert.equal(snap.jump, null);
  assert.ok(!snap.bannerText.includes('⚠'));
});

test('buildQueueAuditSnapshot: a DECREASE in blocked count is never flagged as a jump', () => {
  const classifications = [
    ...Array(50).fill({ verdict: 'OK-TO-DISPATCH' }),
    ...Array(5).fill({ verdict: 'DO-NOT-DISPATCH' }),
  ];
  const history = [
    { at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 30 },
  ];
  const snap = buildQueueAuditSnapshot({ classifications, history, now: NOW });
  assert.equal(snap.jump, null);
});

test('buildQueueAuditSnapshot: previousCount of 0 never divides by zero / never flags', () => {
  const classifications = [{ verdict: 'DO-NOT-DISPATCH' }];
  const history = [{ at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 0 }];
  const snap = buildQueueAuditSnapshot({ classifications, history, now: NOW });
  assert.equal(snap.jump, null);
  assert.ok(Number.isFinite(snap.blockedCount));
});

test('buildQueueAuditSnapshot: empty classifications does not throw, reports zero backlog', () => {
  const snap = buildQueueAuditSnapshot({ classifications: [], history: [], now: NOW });
  assert.equal(snap.blockedCount, 0);
  assert.match(snap.bannerText, /^0 of 0 queued cards blocked/);
});

test('buildQueueAuditSnapshot: skipped/fetch-error cards are surfaced, not silently dropped from the banner', () => {
  const classifications = [
    ...Array(10).fill({ verdict: 'OK-TO-DISPATCH' }),
    ...Array(2).fill({ verdict: 'DO-NOT-DISPATCH' }),
  ];
  const snap = buildQueueAuditSnapshot({
    classifications, history: [], now: NOW, skippedNoUuid: 20, fetchErrors: 4,
  });
  assert.equal(snap.skippedCount, 24);
  assert.match(snap.bannerText, /\[24 queued tasks not counted — 20 no Notion id, 4 fetch\/classify error\]/);
  const notCounted = snap.items.find((i) => i.title === 'NOT COUNTED');
  assert.ok(notCounted, 'expected a NOT COUNTED item row when skips are present');
  assert.match(notCounted.detail, /24 \(20 no id, 4 fetch error\)/);
});

test('buildQueueAuditSnapshot: zero skips omits the NOT COUNTED row and the banner suffix entirely', () => {
  const snap = buildQueueAuditSnapshot({ classifications: [{ verdict: 'OK-TO-DISPATCH' }], history: [], now: NOW });
  assert.equal(snap.skippedCount, 0);
  assert.ok(!snap.items.some((i) => i.title === 'NOT COUNTED'));
  assert.ok(!snap.bannerText.includes('not counted'));
});

test('buildQueueAuditSnapshot: an unresolved (unrecognized) verdict is surfaced as a canary, not silently dropped', () => {
  const classifications = [
    { verdict: 'OK-TO-DISPATCH' },
    { verdict: 'SOME-NEW-VERDICT-NOBODY-UPDATED-THIS-FOR' },
  ];
  const snap = buildQueueAuditSnapshot({ classifications, history: [], now: NOW });
  assert.equal(snap.tally.unresolved, 1);
  const canary = snap.items.find((i) => i.title === 'UNRECOGNIZED VERDICT');
  assert.ok(canary, 'expected an UNRECOGNIZED VERDICT row when tally.unresolved > 0');
});
