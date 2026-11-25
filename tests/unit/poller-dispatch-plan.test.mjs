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

test('BRO-7443: shows past the cap round-robin across iterations, so none is starved (2026-11-12 King\'s Critique)', () => {
  const N = Date.parse('2026-11-13T03:00:00Z');
  const tied = ['first-and-last', 'the-good-thief', 'the-kings-critique'].map((id) => ({ id, embargoMs: N }));
  const seen = new Set();
  for (let it = 0; it < 2; it++) planPollerDispatch({ shows: tied, nowMs: N + 30 * M, rotation: it }).targetedIds.forEach((id) => seen.add(id));
  assert.ok(seen.has('the-kings-critique'), 'every tied in-window show gets a targeted poll within 2 iterations');
  assert.equal(seen.size, 3);
  // near-tie (1 min apart) is covered too, not only exact ties
  const near = [{ id: 'a', embargoMs: N }, { id: 'b', embargoMs: N + M }, { id: 'c', embargoMs: N + 2 * M }];
  const seen2 = new Set();
  for (let it = 0; it < 2; it++) planPollerDispatch({ shows: near, nowMs: N, rotation: it }).targetedIds.forEach((id) => seen2.add(id));
  assert.equal(seen2.size, 3);
});

test('BRO-7443: the hottest show is never rotated out, and deferred shows are named in the reason', () => {
  const four = [hot, hot2, { id: 'x3', embargoMs: E + 40 * M }, { id: 'x4', embargoMs: E + 50 * M }];
  for (const r of [0, 1, 2, 3, -1, NaN, 1e9]) {
    const p = planPollerDispatch({ shows: four, nowMs: E + 15 * M, rotation: r });
    assert.equal(p.targetedIds.length, 2);
    assert.equal(p.targetedIds[0], 'other-hot'); // 5 min from embargo: always kept
    assert.match(p.reason, /deferred this iteration: /);
  }
  assert.doesNotMatch(planPollerDispatch({ shows: [old, hot], nowMs: E }).reason, /deferred/);
});

// The orchestrator is the only caller; pin the wiring that makes the plan matter.
const wf = fs.readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');

test('orchestrator wiring: kill switch, planner CLI, targeted dispatch, deadline-driven loop, no cancel', () => {
  assert.match(wf, /POLLER_PER_SHOW_DISABLED: \$\{\{ vars\.POLLER_PER_SHOW_DISABLED \}\}/);
  assert.match(wf, /scripts\/lib\/poller-dispatch-plan\.js --shows="\$SHOWS"/);
  assert.match(wf, /poller-dispatch-plan\.js [^\n]*--rotation="\$\(\( \$\{ITERATION:-1\} - 1 \)\)"/); // BRO-7443 wiring
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

// BRO-8294: only main-stage Broadway shows get a targeted run; every other market rides the auto run.
test('BRO-8294: a non-Broadway show in its window is left to the auto run (legacy dispatch)', () => {
  for (const category of ['off-broadway', 'west-end', 'off-west-end']) {
    const p = planPollerDispatch({ shows: [old, { ...hot, category }], nowMs: E + 30 * M });
    assert.equal(p.mode, 'legacy', category);
    assert.deepEqual(p.targetedIds, [], category);
    assert.match(p.reason, /left to the auto run: blueberries/, category);
  }
});

test('BRO-8294: a non-Broadway show never takes a targeted slot from a Broadway show', () => {
  const offClose = { id: 'off-close', embargoMs: E + 5 * M, category: 'off-broadway' };
  const weClose = { id: 'we-close', embargoMs: E + 6 * M, category: 'west-end' };
  const bway = { id: 'bway-far', embargoMs: E + 40 * M, category: 'broadway' };
  const bway2 = { id: 'bway-far2', embargoMs: E + 50 * M };
  // Old behaviour: the two Off/WE shows (nearest the embargo) fill both slots and the Broadway show gets none.
  const withNon = planPollerDispatch({ shows: [offClose, weClose, bway, bway2], nowMs: E + 10 * M, includeNonBroadway: true });
  assert.deepEqual(withNon.targetedIds.slice().sort(), ['off-close', 'we-close']);
  const p = planPollerDispatch({ shows: [offClose, weClose, bway, bway2], nowMs: E + 10 * M });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(p.targetedIds, ['bway-far', 'bway-far2']);
  assert.match(p.reason, /non-Broadway left to the auto run: (off-close,we-close|we-close,off-close)/);
});

test('BRO-8294: Broadway targeted ids are a superset of the old plan at every rotation', () => {
  const mix = [
    { id: 'b1', embargoMs: E, category: 'broadway' }, { id: 'b2', embargoMs: E + 15 * M, category: 'broadway' },
    { id: 'b3', embargoMs: E + 40 * M, category: 'broadway' },
    { id: 'o1', embargoMs: E + 2 * M, category: 'off-broadway' }, { id: 'w1', embargoMs: E + 3 * M, category: 'west-end' },
  ];
  for (let rotation = 0; rotation < 8; rotation++) {
    for (const t of [-30, 0, 20, 90, 300]) {
      const oldIds = planPollerDispatch({ shows: mix, nowMs: E + t * M, rotation, includeNonBroadway: true }).targetedIds.filter((i) => i.startsWith('b'));
      const newIds = planPollerDispatch({ shows: mix, nowMs: E + t * M, rotation }).targetedIds;
      assert.ok(oldIds.every((i) => newIds.includes(i)), `rot ${rotation} t ${t}: ${oldIds} not in ${newIds}`);
    }
  }
});

test('BRO-8294: the kill switch (includeNonBroadway) restores any-market targeting exactly', () => {
  const p = planPollerDispatch({ shows: [old, { ...hot, category: 'west-end' }], nowMs: E + 30 * M, includeNonBroadway: true });
  assert.equal(p.mode, 'parallel');
  assert.deepEqual(p.targetedIds, ['blueberries']);
});

test('BRO-8294: the CLI wires category and the kill switch through (the workflow calls the CLI, not the function)', () => {
  const src = fs.readFileSync(new URL('../../scripts/lib/poller-dispatch-plan.js', import.meta.url), 'utf8');
  assert.match(src, /category: s \? s\.category : undefined/);
  assert.match(src, /includeNonBroadway: arg\('non-broadway-targeted'\) === 'true'/);
  const wf = fs.readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');
  assert.match(wf, /POLLER_NON_BROADWAY_TARGETED: \$\{\{ vars\.POLLER_NON_BROADWAY_TARGETED \}\}/);
  assert.match(wf, /--non-broadway-targeted="\$\{POLLER_NON_BROADWAY_TARGETED:-\}"/);
});
