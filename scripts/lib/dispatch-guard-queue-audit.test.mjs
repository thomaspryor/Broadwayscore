import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tallyGuardRefusals, findWeekAgoEntry, buildDispatchGuardQueueAuditSnapshot,
  guardLabel, JUMP_THRESHOLD_PCT, GUARD_NAMES,
} from './dispatch-guard-queue-audit.js';

const DAY_MS = 24 * 3600e3;
const NOW = new Date('2026-08-19T12:00:00Z').getTime();

function taskResult(taskId, overrides = {}) {
  const guards = {};
  for (const name of GUARD_NAMES) guards[name] = { refusal: null };
  return { taskId, guards: { ...guards, ...overrides } };
}

test('GUARD_NAMES: all 8 sibling guards are named', () => {
  assert.deepEqual(GUARD_NAMES, [
    'deadDispatchGuard', 'parkedGuard', 'staleOutcomeGuard', 'closedCardGuard',
    'workBranchCollisionGuard', 'exactTitleOverlapGuard', 'sessionTrackingCloneGuard',
    'linearMirrorGuard',
  ]);
});

test('tallyGuardRefusals: all-clear task counts as ok on every guard, not blocked', () => {
  const tally = tallyGuardRefusals([taskResult(1), taskResult(2)]);
  for (const name of GUARD_NAMES) {
    assert.equal(tally.byGuard[name].ok, 2);
    assert.equal(tally.byGuard[name].refused, 0);
    assert.equal(tally.byGuard[name].error, 0);
  }
  assert.equal(tally.blockedTasks, 0);
  assert.equal(tally.total, 2);
});

test('tallyGuardRefusals: a refusal on ANY one guard marks the task blocked, beyond predispatch-guard alone', () => {
  const tally = tallyGuardRefusals([
    taskResult(1, { linearMirrorGuard: { refusal: 'already has a live Linear counterpart' } }),
    taskResult(2, { workBranchCollisionGuard: { refusal: 'unlanded branch collision' } }),
    taskResult(3),
  ]);
  assert.equal(tally.byGuard.linearMirrorGuard.refused, 1);
  assert.equal(tally.byGuard.workBranchCollisionGuard.refused, 1);
  assert.equal(tally.byGuard.deadDispatchGuard.refused, 0);
  assert.equal(tally.blockedTasks, 2);
});

test('tallyGuardRefusals: a task refused by TWO guards counts once in blockedTasks', () => {
  const tally = tallyGuardRefusals([
    taskResult(1, {
      staleOutcomeGuard: { refusal: 'already has a filled Outcome' },
      closedCardGuard: { refusal: 'already Done' },
    }),
  ]);
  assert.equal(tally.byGuard.staleOutcomeGuard.refused, 1);
  assert.equal(tally.byGuard.closedCardGuard.refused, 1);
  assert.equal(tally.blockedTasks, 1);
});

test('tallyGuardRefusals: a null/undefined per-guard entry tallies as error, never folded into ok', () => {
  const tally = tallyGuardRefusals([
    { taskId: 1, guards: { deadDispatchGuard: undefined, parkedGuard: null } },
  ]);
  assert.equal(tally.byGuard.deadDispatchGuard.error, 1);
  assert.equal(tally.byGuard.deadDispatchGuard.ok, 0);
  assert.equal(tally.byGuard.parkedGuard.error, 1);
  // guards never present in the per-task object are also missing -> error
  assert.equal(tally.byGuard.staleOutcomeGuard.error, 1);
});

test('tallyGuardRefusals: empty/undefined input tallies to all zeros', () => {
  const tally = tallyGuardRefusals([]);
  assert.equal(tally.blockedTasks, 0);
  assert.equal(tally.total, 0);
  for (const name of GUARD_NAMES) assert.deepEqual(tally.byGuard[name], { refused: 0, ok: 0, error: 0, total: 0 });
  assert.deepEqual(tallyGuardRefusals(undefined).byGuard, tally.byGuard);
});

test('findWeekAgoEntry: picks the entry closest to 7 days old within the 5-9 day window', () => {
  const history = [
    { at: new Date(NOW - 1 * DAY_MS).toISOString(), blockedCount: 10 },
    { at: new Date(NOW - 6 * DAY_MS).toISOString(), blockedCount: 20 },
    { at: new Date(NOW - 7.2 * DAY_MS).toISOString(), blockedCount: 30 },
    { at: new Date(NOW - 20 * DAY_MS).toISOString(), blockedCount: 5 },
  ];
  assert.equal(findWeekAgoEntry(history, NOW).blockedCount, 30);
});

test('findWeekAgoEntry: no entries in window, malformed input -> null, never throws', () => {
  assert.equal(findWeekAgoEntry([], NOW), null);
  assert.equal(findWeekAgoEntry(undefined, NOW), null);
  assert.equal(findWeekAgoEntry([null, { at: 'garbage', blockedCount: 5 }], NOW), null);
});

test('guardLabel: camelCase guard name -> readable title', () => {
  assert.equal(guardLabel('workBranchCollisionGuard'), 'Work Branch Collision');
  assert.equal(guardLabel('linearMirrorGuard'), 'Linear Mirror');
  assert.equal(guardLabel('deadDispatchGuard'), 'Dead Dispatch');
});

test('buildDispatchGuardQueueAuditSnapshot: steady state (no history) reports plain count, no jump', () => {
  const results = [
    ...Array(18).fill(null).map((_, i) => taskResult(i)),
    taskResult(100, { linearMirrorGuard: { refusal: 'live Linear counterpart' } }),
    taskResult(101, { workBranchCollisionGuard: { refusal: 'unlanded branch' } }),
  ];
  const snap = buildDispatchGuardQueueAuditSnapshot({ results, history: [], now: NOW });
  assert.equal(snap.blockedCount, 2);
  assert.equal(snap.jump, null);
  assert.match(snap.bannerText, /2 of 20 queued cards blocked by at least one dispatch guard/);
  assert.ok(!snap.bannerText.includes('⚠'));
  assert.equal(snap.generatedAt, new Date(NOW).toISOString());
});

test('buildDispatchGuardQueueAuditSnapshot: items list breaks down per-guard, not just an aggregate number', () => {
  const results = [
    taskResult(1, { linearMirrorGuard: { refusal: 'x' } }),
    taskResult(2, { linearMirrorGuard: { refusal: 'x' } }),
    taskResult(3, { linearMirrorGuard: { refusal: 'x' } }),
    taskResult(4, { deadDispatchGuard: { refusal: 'y' } }),
  ];
  const snap = buildDispatchGuardQueueAuditSnapshot({ results, now: NOW });
  const linear = snap.items.find(i => i.title === 'Linear Mirror');
  const dead = snap.items.find(i => i.title === 'Dead Dispatch');
  assert.ok(linear, 'expected a per-guard item for the guard that actually spiked');
  assert.match(linear.detail, /3 refused/);
  assert.ok(dead);
  // sorted by refused count descending — the spiking guard leads
  assert.equal(snap.items[0].title, 'Linear Mirror');
});

test('buildDispatchGuardQueueAuditSnapshot: all-clear run reports one placeholder item, not an empty list', () => {
  const snap = buildDispatchGuardQueueAuditSnapshot({ results: [taskResult(1), taskResult(2)], now: NOW });
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].title, 'All guards clear');
});

test('buildDispatchGuardQueueAuditSnapshot: a real week-over-week jump above threshold is flagged', () => {
  const results = [
    ...Array(10).fill(null).map((_, i) => taskResult(i)),
    ...Array(20).fill(null).map((_, i) => taskResult(100 + i, { linearMirrorGuard: { refusal: 'x' } })),
  ];
  const history = [{ at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 10 }];
  const snap = buildDispatchGuardQueueAuditSnapshot({ results, history, now: NOW });
  assert.ok(snap.jump);
  assert.equal(snap.jump.previousCount, 10);
  assert.ok(snap.jump.pctChange >= JUMP_THRESHOLD_PCT);
  assert.match(snap.bannerText, /^⚠ dispatch-guard-blocked backlog jumped to 20/);
});

test('buildDispatchGuardQueueAuditSnapshot: previousCount of 0 never divides by zero / never flags', () => {
  const results = [taskResult(1, { linearMirrorGuard: { refusal: 'x' } })];
  const history = [{ at: new Date(NOW - 7 * DAY_MS).toISOString(), blockedCount: 0 }];
  const snap = buildDispatchGuardQueueAuditSnapshot({ results, history, now: NOW });
  assert.equal(snap.jump, null);
  assert.ok(Number.isFinite(snap.blockedCount));
});

test('buildDispatchGuardQueueAuditSnapshot: skippedTasks surfaces in bannerText so real skips never read as a quiet day', () => {
  const snap = buildDispatchGuardQueueAuditSnapshot({ results: [taskResult(1)], skippedTasks: 3, now: NOW });
  assert.match(snap.bannerText, /3 queued tasks not evaluated/);
  assert.equal(snap.skippedCount, 3);
});

test('buildDispatchGuardQueueAuditSnapshot: per-guard execution errors are visible in items, not silently dropped', () => {
  const results = [
    { taskId: 1, guards: { deadDispatchGuard: null } },
  ];
  const snap = buildDispatchGuardQueueAuditSnapshot({ results, now: NOW });
  const item = snap.items.find(i => i.title === 'Dead Dispatch');
  assert.ok(item);
  assert.match(item.detail, /not evaluated/);
});

test('buildDispatchGuardQueueAuditSnapshot: empty results does not throw, reports zero backlog', () => {
  const snap = buildDispatchGuardQueueAuditSnapshot({ results: [], history: [], now: NOW });
  assert.equal(snap.blockedCount, 0);
  assert.equal(snap.tally.total, 0);
});
