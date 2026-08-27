// BRO-409 — dispatch loop stopped launching for 7.5h (2026-08-17) with 207
// eligible P0/P1 cards queued. The existing backstop's intervene condition
// (live auto-dispatch tabs < 3 AND zero ledger launches in 45m) never fired
// because live tabs sat pinned at exactly 3 the entire time — a stalled
// launcher holding exactly the minimum tab count is invisible to a check
// that only fires BELOW the minimum. This reproduces that incident shape
// against the real decision function (CLAUDE.md rule 15 — never copy guard
// logic into a test) and pins the new eligible-queue-depth term that closes
// the gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isDispatchFlowDead,
  MIN_LIVE_AUTO_WORKSPACES,
  STALL_QUEUE_DEPTH_THRESHOLD,
} = require('../../scripts/lib/dispatch-flow-health.js');
const {
  planSweep,
  CAPS,
  CLAIM_OUTAGE_MIN,
  CLAIM_LABEL_GRACE_MS,
  WATCHDOG_EVENTS,
} = require('../../scripts/lib/dispatch-watchdog-core.js');

test('BRO-409 incident shape: live tabs at min, zero launches, deep eligible queue -> dead', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: 207 }),
    true,
  );
});

test('queue depth at the threshold does not trip', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: STALL_QUEUE_DEPTH_THRESHOLD }),
    false,
  );
});

test('queue depth just above the threshold trips', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: STALL_QUEUE_DEPTH_THRESHOLD + 1 }),
    true,
  );
});

test('any recent launch prevents the queue-depth path from tripping, even with a huge queue', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 1, eligibleQueueDepth: 500 }),
    false,
  );
});

test('unknown queue depth (-1 sentinel) never trips the new path on its own', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0, eligibleQueueDepth: -1 }),
    false,
  );
});

test('omitting eligibleQueueDepth defaults to the -1 sentinel (backward compatible)', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES, launchesLast45m: 0 }),
    false,
  );
});

test('pre-existing tab-count path still fires independent of queue depth', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 0, eligibleQueueDepth: 0 }),
    true,
  );
});

test('unreadable ledger sentinel still wins over a deep queue and a low tab count', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: 0, launchesLast45m: -1, eligibleQueueDepth: 999 }),
    false,
  );
});

// BRO-2462 — the OLD tab-count path (liveAutoWorkspaces < MIN, unlike the
// eligibleQueueDepth path BRO-409 added) had no gate at all: it paged during
// a deliberate dispatch pause or a routine day-budget/concurrency/tab-ceiling
// cap, exactly the anti-pattern this file's header warns against. dispatchPaused
// closes that gap on the pure decision function; the planSweep-level tests
// below confirm the caller only sets it true for a genuine policy pause, never
// for a detected failure (which must still page).

test('BRO-2462: dispatchPaused suppresses the tab-count path during a genuine policy pause', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 0, dispatchPaused: true }),
    false,
  );
});

test('BRO-2462: dispatchPaused defaults to false — tab-count path still fires unchanged', () => {
  assert.equal(
    isDispatchFlowDead({ liveAutoWorkspaces: 1, launchesLast45m: 0 }),
    true,
  );
});

test('BRO-2462: dispatchPaused also suppresses the eligibleQueueDepth path', () => {
  assert.equal(
    isDispatchFlowDead({
      liveAutoWorkspaces: MIN_LIVE_AUTO_WORKSPACES,
      launchesLast45m: 0,
      eligibleQueueDepth: STALL_QUEUE_DEPTH_THRESHOLD + 1,
      dispatchPaused: true,
    }),
    false,
  );
});

// planSweep-level: the second-opinion review on this fix caught that
// plan.budgets.holds mixes policy pauses (kill-switch, day budget,
// concurrency cap, tab ceiling) with failure-DETECTION signals (launcher
// outage, failure-rate leak, claim outage) — gating dispatchPaused on
// `holds.length > 0` would have silenced the tab-count backstop during an
// actual detected stall, the single worst regression this fix could
// introduce. pausedByPolicy must stay narrower than holds.

test('BRO-2462: day-budget-spent is a policy pause — pausedByPolicy true', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const entries = Array.from({ length: CAPS.perDay }, (_, i) => ({
    event: WATCHDOG_EVENTS.REDISPATCH,
    taskId: `budget-${i}`,
    ts: new Date(now).toISOString(),
  }));
  const plan = planSweep(entries, new Map(), { now, dispatchEnabled: true });
  assert.equal(plan.budgets.pausedByPolicy, true);
  assert.ok(plan.budgets.holds.some(h => h.includes('day budget spent')));
});

test('BRO-2462: a claim-outage (wedged launcher) is NOT a policy pause — pausedByPolicy stays false even though holds is non-empty', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const claimAgeMs = CLAIM_LABEL_GRACE_MS * 2; // past the boot-window grace, well under the 24h rearm
  const tasks = new Map();
  const entries = [];
  for (let i = 0; i < CLAIM_OUTAGE_MIN; i++) {
    const taskId = `wedged-${i}`;
    tasks.set(taskId, { id: taskId, status: 'pending', subject: `P1: wedged task ${i}`, description: 'P1 wedged' });
    entries.push({ event: WATCHDOG_EVENTS.REDISPATCH, taskId, ts: new Date(now - claimAgeMs).toISOString() });
  }
  // No 'launch' events anywhere -> lastLaunchAnywhereMs is null -> claimOutage
  // trips regardless of window, per dispatch-watchdog-core.js's own claimOutage test.
  const plan = planSweep(entries, tasks, { now, dispatchEnabled: true });
  assert.ok(plan.budgets.holds.some(h => h.includes('the launcher itself looks wedged')), 'expected a claim-outage hold');
  assert.equal(plan.budgets.pausedByPolicy, false);
});

// Ship-check adversarial catch: only 2 of the 8 hold types were exercised at
// the planSweep level above — a future edit to pausedByPolicy's flat OR-chain
// could flip or drop one clause and only those 2 cases would still fail.
// The remaining 6 close that drift-detection gap.

test('BRO-2462: dispatch kill-switch is a policy pause — pausedByPolicy true', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const plan = planSweep([], new Map(), { now, dispatchEnabled: false });
  assert.equal(plan.budgets.pausedByPolicy, true);
  assert.ok(plan.budgets.holds.some(h => h.includes('dispatch kill-switch set')));
});

test('BRO-2462: watchdog concurrency at cap is a policy pause — pausedByPolicy true', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const tasks = new Map();
  const entries = [];
  for (let i = 0; i < CAPS.watchdogConcurrent; i++) {
    const taskId = `live-${i}`;
    entries.push({ event: WATCHDOG_EVENTS.REDISPATCH, taskId, ts: new Date(now).toISOString() });
    entries.push({ event: 'launch', taskId, workspaceRef: `workspace:${i}`, ts: new Date(now).toISOString() });
  }
  const plan = planSweep(entries, tasks, { now, dispatchEnabled: true });
  assert.equal(plan.budgets.pausedByPolicy, true);
  assert.ok(plan.budgets.holds.some(h => h.includes('watchdog concurrency at cap')));
});

test('BRO-2462: global auto-tab ceiling is a policy pause — pausedByPolicy true', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const liveTitles = new Map(Array.from({ length: CAPS.globalAutoTabs }, (_, i) => [`workspace:${i}`, `🤖 Data·task ${i}`]));
  const plan = planSweep([], new Map(), { now, dispatchEnabled: true, liveTitles });
  assert.equal(plan.budgets.pausedByPolicy, true);
  assert.ok(plan.budgets.holds.some(h => h.includes('global auto-tab ceiling')));
});

test('BRO-2462: cmux unobservable is NOT a policy pause — pausedByPolicy stays false', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const plan = planSweep([], new Map(), { now, dispatchEnabled: true, liveTitles: null });
  assert.ok(plan.budgets.holds.some(h => h.includes('cmux unobservable')));
  assert.equal(plan.budgets.pausedByPolicy, false);
});

test('BRO-2462: a detected launcher outage is NOT a policy pause — pausedByPolicy stays false', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  const entries = Array.from({ length: 3 }, (_, i) => ({
    event: 'dead',
    taskId: `outage-${i}`,
    workspaceRef: `workspace:${i}`,
    failureReason: 'injection never ran',
    ts: new Date(now - 5 * 60 * 1000).toISOString(), // within OUTAGE_LOOKBACK_MS (30min), no later recovering launch
  }));
  const plan = planSweep(entries, new Map(), { now, dispatchEnabled: true });
  assert.ok(plan.budgets.holds.some(h => h.includes('launcher outage detected')));
  assert.equal(plan.budgets.pausedByPolicy, false);
});

test('BRO-2462: a leaky launcher failure rate is NOT a policy pause — pausedByPolicy stays false', () => {
  const now = Date.parse('2026-08-20T12:00:00.000Z');
  // Deaths sit outside the 30min outage lookback but inside the 6h leak
  // lookback, isolating the leak signal from the outage signal.
  const deathTs = new Date(now - 45 * 60 * 1000).toISOString();
  const entries = [];
  // Every 'dead' is paired with its own (unverified) 'launch' — the real
  // failedLaunchEntries() invariant this detector's denominator relies on
  // (dispatch-ledger.js's detectLauncherFailureRate comment above).
  for (let i = 0; i < 3; i++) {
    entries.push({ event: 'launch', taskId: `leak-${i}`, workspaceRef: `workspace:${i}`, unverified: true, ts: deathTs });
    entries.push({ event: 'dead', taskId: `leak-${i}`, workspaceRef: `workspace:${i}`, failureReason: 'injection never ran', ts: deathTs });
  }
  for (let i = 3; i < 10; i++) {
    entries.push({ event: 'launch', taskId: `leak-${i}`, workspaceRef: `workspace:${i}`, ts: deathTs });
  }
  const plan = planSweep(entries, new Map(), { now, dispatchEnabled: true });
  assert.ok(plan.budgets.holds.some(h => h.includes('injection deaths in the last')), 'expected a failure-rate-leak hold');
  assert.equal(plan.budgets.pausedByPolicy, false);
});
