// BRO-7198: a slow auto-discovery poller run must not be the only poll a show in its opening window gets.
// 2026-11-10 Blueberries: multi-show selection dispatched only the 50-110 min auto run (shared group); the
// targeted show_id run (4-6 min) is dispatched and waited on for the hottest in-window shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { planPollerDispatch, MAX_TARGETED } = require('../../scripts/lib/poller-dispatch-plan.js');
const E = Date.parse('2026-11-10T03:00:00Z');
const M = 60000;
const hot = { id: 'blueberries', embargoMs: E };
const old = { id: 'ms-blakk', embargoMs: E - 24 * 60 * M };
const hot2 = { id: 'other-hot', embargoMs: E + 20 * M };

test('multi-show selection with a show in its window dispatches that show targeted (the Blueberries night case)', () => {
  const p = planPollerDispatch({ shows: [old, hot], nowMs: E + 130 * M });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(p.targetedIds, ['blueberries']);
});

test('one show, no show, or no show in its window keeps the legacy dispatch', () => {
  assert.equal(planPollerDispatch({ shows: [hot], nowMs: E + 10 * M }).mode, 'legacy');
  assert.equal(planPollerDispatch({ shows: [], nowMs: E }).mode, 'legacy');
  assert.equal(planPollerDispatch({ shows: [old, { id: 'x', embargoMs: NaN }], nowMs: E }).mode, 'legacy');
  assert.equal(planPollerDispatch({ shows: [old, hot], nowMs: E + 8 * 60 * M }).mode, 'legacy'); // past +7h
});

test('window is [embargo-1h, embargo+7h]', () => {
  assert.equal(planPollerDispatch({ shows: [old, hot], nowMs: E - 61 * M }).mode, 'legacy');
  assert.equal(planPollerDispatch({ shows: [old, hot], nowMs: E - 59 * M }).mode, 'parallel');
  assert.equal(planPollerDispatch({ shows: [old, hot], nowMs: E + 419 * M }).mode, 'parallel');
  assert.equal(planPollerDispatch({ shows: [old, hot], nowMs: E + 421 * M }).mode, 'legacy');
});

test('the kill switch restores the legacy dispatch exactly', () => {
  const p = planPollerDispatch({ shows: [old, hot], nowMs: E + 60 * M, disabled: true });
  assert.equal(p.mode, 'legacy');
  assert.deepEqual(p.targetedIds, []);
});

test('at most MAX_TARGETED shows, hottest (nearest the embargo) first, ties broken by id', () => {
  assert.equal(MAX_TARGETED, 2);
  const third = { id: 'third', embargoMs: E + 200 * M };
  const p = planPollerDispatch({ shows: [third, hot, hot2, old], nowMs: E + 30 * M });
  assert.deepEqual(p.targetedIds, ['other-hot', 'blueberries']); // 10 min and 30 min from embargo; third (170 min) is capped out
});

// The orchestrator is the only caller; pin the wiring that makes the plan matter.
const wf = fs.readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');

test('orchestrator wiring: kill switch, planner CLI, targeted dispatch, deadline-driven loop, no cancel', () => {
  assert.match(wf, /POLLER_PER_SHOW_DISABLED: \$\{\{ vars\.POLLER_PER_SHOW_DISABLED \}\}/);
  assert.match(wf, /scripts\/lib\/poller-dispatch-plan\.js --shows="\$SHOWS"/);
  assert.match(wf, /gh workflow run opening-night-poller\.yml -f show_id="\$id" \$POLLER_ARGS/);
  assert.match(wf, /if \[ "\$PLAN_MODE" = "parallel" \]; then\s+dispatch_parallel\s+else/);
  assert.match(wf, /MAX_ITERATIONS=48/); // parallel iterations are minutes: run to DEADLINE, not 10 iterations
  // the clock kicks at embargo-2h, before the window opens: the cap must be raised up front for any multi-show run
  assert.match(wf, /\[\[ "\$SHOWS" == \*,\* \]\] && \[ "\$\{POLLER_PER_SHOW_DISABLED:-\}" != "true" \]/);
  assert.match(wf, /ITERATION" -gt "\$BASE_MAX_ITERATIONS" \] && \[ "\$PLAN_MODE" != "parallel"/);
  assert.match(wf, /-lt 120 \] && SERP_DEFER_NOW=true/); // SERP deferral by wall clock in parallel mode
  assert.ok(!/gh run cancel/.test(wf.slice(wf.indexOf('dispatch_parallel() {'), wf.indexOf('plan_dispatch\n          if'))), 'never cancels a run');
});

test('orchestrator still dispatches the guarded auto run in parallel mode and does not wait on it', () => {
  const body = wf.slice(wf.indexOf('dispatch_parallel() {'), wf.indexOf('plan_dispatch\n          if'));
  assert.match(body, /-f lookback_days=/);
  assert.match(body, /BRO-2358/);
  // only targeted run ids are added to the wait list
  assert.ok(!/WAIT_IDS="\$WAIT_IDS \$PREV_POLLER_RUN_ID"/.test(body));
});
