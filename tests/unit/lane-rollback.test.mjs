// BRO-6622 (cutover card 8): the lane switch and the lane rollback. Requires the real decision module
// (scripts/lib/opening-night-lane/lane-switch.js) and drives executeRollback with stub ports, then runs the real CLI
// for its refusals and pins the workflow wiring by reading the real YAML: workflow_dispatch only, the two variable
// names only, mode with no default, no concurrency group, the token the orchestrator uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ls = require('../../scripts/lib/opening-night-lane/lane-switch.js');
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');
const { oldPathDispatchArgs } = require('../../scripts/lib/opening-night-lane/old-path-dispatch.js');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

const NOW = Date.parse('2026-11-13T03:30:00Z');
const SHOW = 'bway-show';
const NIGHT = '2026-11-12';
const KEY = `${SHOW}|${NIGHT}`;
const TITLE = `Opening-night lane night ${SHOW} ${NIGHT}`;
const liveLease = (holder = 'lane-run-1') => ({ leases: { [KEY]: { holder, expiresAt: new Date(NOW + 20 * 60000).toISOString() } } });
const VARS_ON = { onlyMarkets: { ok: true, value: 'broadway' }, standdown: { ok: true, value: '' } };

/**
 * Stub world: leases and runs are mutable, every port call is logged in order. script(n) can change the world on the
 * n-th observation (the lane standing down by itself, a cancelled run finishing).
 */
function world({ leases = liveLease(), runs = [{ databaseId: 11, displayTitle: TITLE, status: 'in_progress' }], vars403 = false, inWindow = true, script = () => {} } = {}) {
  const w = { leases, runs, fallbacks: { leases: {} }, calls: [], clock: NOW, reads: 0 };
  const cas = (get, set) => (fn) => { const out = fn(get()); if (out.ok) set(out.state); return { ...out, state: undefined }; };
  w.ports = {
    setVar: (n, v) => { w.calls.push(`set ${n}=${v}`); return vars403 ? { ok: false, detail: 'HTTP 403' } : { ok: true }; },
    deleteVar: (n) => { w.calls.push(`delete ${n}`); return vars403 ? { ok: false, detail: 'HTTP 403' } : { ok: true }; },
    readLeaseState: () => { w.reads += 1; script(w.reads, w); return w.leases; },
    listNightRuns: () => w.runs,
    cancelRun: (id) => { w.calls.push(`cancel ${id}`); return { ok: true }; },
    release: cas(() => w.leases, (s) => { w.calls.push('release'); w.leases = s; }),
    claim: cas(() => w.fallbacks, (s) => { w.fallbacks = s; }),
    dispatchOldPath: (s) => { w.calls.push(`dispatch ${s}`); return true; },
    inWindow: () => inWindow,
    sleep: async (ms) => { w.clock += ms; },
    now: () => w.clock,
    log: () => {},
  };
  return w;
}
const plan = (w, extra = {}) => ls.planRollback({ show: SHOW, night: NIGHT, now: NOW, vars: VARS_ON, leaseState: w.leases, laneRuns: w.runs, ...extra });

test('only the two variable names are accepted, typos and empty set values are refused', () => {
  for (const variable of ['ORCHESTRATOR_PAUSED', 'LANE_ONLY_MARKET', 'lane_standdown', '', null]) {
    assert.equal(ls.validateSwitch({ action: 'set', variable, value: 'broadway' }).ok, false, String(variable));
  }
  assert.deepEqual(ls.validateSwitch({ action: 'set', variable: 'LANE_ONLY_MARKETS', value: ' Broadway ' }), { ok: true, variable: 'LANE_ONLY_MARKETS', op: 'set', value: 'broadway' });
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_ONLY_MARKETS', value: 'broadwya' }).ok, false, 'a typo would mean nothing');
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_STANDDOWN', value: 'west-edn' }).ok, false, 'a typo would mean all');
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_ONLY_MARKETS', value: 'all' }).ok, false, 'all is a stand-down word');
  assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_STANDDOWN', value: 'all' }).value, 'all');
  for (const value of ['', '  ', 'none', 'false', 'off']) {
    assert.equal(ls.validateSwitch({ action: 'set', variable: 'LANE_STANDDOWN', value }).ok, false, `set "${value}" must use clear`);
  }
  assert.deepEqual(ls.validateSwitch({ action: 'clear', variable: 'LANE_ONLY_MARKETS', value: '' }), { ok: true, variable: 'LANE_ONLY_MARKETS', op: 'delete', value: '' });
  assert.equal(ls.validateSwitch({ action: 'clear', variable: 'LANE_ONLY_MARKETS', value: 'broadway' }).ok, false);
  assert.equal(ls.validateSwitch({ action: 'toggle', variable: 'LANE_STANDDOWN', value: 'all' }).ok, false);
});

test('plan: variables first, targets from the live lease and the in-flight night run, smoke runs ignored', () => {
  const w = world({ runs: [{ databaseId: 11, displayTitle: TITLE, status: 'in_progress' }, { databaseId: 12, displayTitle: 'Opening-night lane smoke x', status: 'in_progress' }, { databaseId: 13, displayTitle: TITLE, status: 'completed' }] });
  const p = ls.planRollback({ now: NOW, vars: VARS_ON, leaseState: w.leases, laneRuns: w.runs });
  assert.deepEqual(p.varSteps.map((s) => s.op), ['set-var', 'delete-var']);
  assert.deepEqual(p.targets, [{ show: SHOW, night: NIGHT, holder: 'lane-run-1', runIds: [11] }]);
  assert.deepEqual(ls.restoreCalls(p.varSteps), ['clear LANE_STANDDOWN', 'set LANE_ONLY_MARKETS=broadway']);
  const done = ls.planRollback({ now: NOW, vars: { onlyMarkets: { ok: true, value: '' }, standdown: { ok: true, value: 'all' } }, leaseState: { leases: {} }, laneRuns: [] });
  assert.deepEqual(done.varSteps, [], 'already rolled back: no variable writes');
  assert.throws(() => ls.planRollback({ show: SHOW, now: NOW, vars: VARS_ON, leaseState: w.leases, laneRuns: [] }));
  const blind = ls.planRollback({ now: NOW, vars: { onlyMarkets: { ok: false }, standdown: { ok: false } }, leaseState: { unknown: true }, laneRuns: null });
  assert.equal(blind.varSteps.length, 2, 'unreadable variables are still written');
  assert.equal(blind.warnings.filter((x) => /unreadable/.test(x)).length, 2);
  assert.deepEqual(ls.restoreCalls(blind.varSteps), [], 'unknown old values give no restore line');
});

test('the lane stands down by itself: no cancel, no release, old path dispatched once', async () => {
  const w = world({ script: (n, x) => { if (n === 3) { x.leases = { leases: {} }; x.runs = [{ databaseId: 11, displayTitle: TITLE, status: 'completed' }]; } } });
  const r = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1' });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls, ['set LANE_STANDDOWN=all', 'delete LANE_ONLY_MARKETS', `dispatch ${SHOW}`]);
  assert.equal(w.fallbacks.leases[KEY].dispatched, true);
});

test('a lane still holding after the wait: cancel, wait for the run to finish, then release, then dispatch', async () => {
  let cancelledAt = null;
  const w = world({ script: (n, x) => { if (cancelledAt && n >= cancelledAt + 2) x.runs = [{ databaseId: 11, displayTitle: TITLE, status: 'completed' }]; } });
  const cancel = w.ports.cancelRun;
  w.ports.cancelRun = (id) => { cancelledAt = w.reads; return cancel(id); };
  const r = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1' });
  assert.equal(r.ok, true);
  assert.deepEqual(w.calls, ['set LANE_STANDDOWN=all', 'delete LANE_ONLY_MARKETS', 'cancel 11', 'release', `dispatch ${SHOW}`]);
  assert.ok(w.clock - NOW >= ls.STANDDOWN_WAIT_MIN * 60000, 'waited the full stand-down cap before cancelling');
  const ops = r.results.map((x) => x.step.op);
  assert.ok(ops.indexOf('wait-run') < ops.indexOf('release-lease'), 'never release before the cancelled run finished');
  assert.equal(w.leases.leases[KEY], undefined);
});

test('hard: cancel at once, no stand-down wait', async () => {
  const w = world({ script: (n, x) => { if (n >= 3) x.runs = []; } });
  const r = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r.ok, true);
  assert.ok(!r.results.some((x) => x.step.op === 'wait-standdown'));
  assert.ok(w.clock - NOW < ls.STANDDOWN_WAIT_MIN * 60000);
});

test('a variable 403 still releases the lease and hands the night to the old path; the run goes red', async () => {
  const w = world({ vars403: true, runs: [] });
  const r = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r.ok, false);
  assert.deepEqual(w.calls.slice(2), ['release', `dispatch ${SHOW}`]);
});

test('lease already gone is success; a lease that changed hands is left alone and fails', async () => {
  const gone = world({ runs: [] });
  const p = plan(gone);
  gone.leases = { leases: {} };
  const r1 = await ls.executeRollback(p, gone.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r1.results.find((x) => x.step.op === 'release-lease').ok, true);
  const moved = world({ runs: [] });
  const p2 = plan(moved);
  moved.leases = liveLease('lane-run-2');
  const r2 = await ls.executeRollback(p2, moved.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r2.ok, false);
  assert.equal(moved.leases.leases[KEY].holder, 'lane-run-2', 'a fresh lane claim is never cut');
});

test('a night whose lease changed hands or whose run never finished gets no old-path run', async () => {
  const moved = world({ runs: [] });
  const p = plan(moved);
  moved.leases = liveLease('lane-run-2');
  const r1 = await ls.executeRollback(p, moved.ports, { holder: 'rollback:1', hard: true });
  assert.equal(moved.calls.filter((c) => c.startsWith('dispatch')).length, 0, 'the orchestrator would skip a held show');
  assert.equal(r1.results.find((x) => x.step.op === 'fallback').ok, false);
  assert.deepEqual(moved.fallbacks, { leases: {} }, 'no claim, so a re-run can still dispatch');
  const stuck = world();
  const r2 = await ls.executeRollback(plan(stuck), stuck.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r2.ok, false);
  assert.ok(!stuck.calls.includes('release'), 'a run still writing keeps its lease');
  assert.equal(stuck.calls.filter((c) => c.startsWith('dispatch')).length, 0);
  assert.match(r2.results.find((x) => x.step.op === 'wait-run').note, /re-run the rollback/);
});

test('several nights: every run is cancelled first, then one shared wait', async () => {
  const T2 = 'Opening-night lane night other-show 2026-11-12';
  const w = world({ runs: [{ databaseId: 11, displayTitle: TITLE, status: 'in_progress' }, { databaseId: 12, displayTitle: T2, status: 'in_progress' }],
    script: (n, x) => { if (x.calls.includes('cancel 12')) x.runs = []; } });
  const p = ls.planRollback({ now: NOW, vars: VARS_ON, leaseState: w.leases, laneRuns: w.runs });
  const r = await ls.executeRollback(p, w.ports, { holder: 'rollback:1', hard: true });
  assert.deepEqual(w.calls.filter((c) => c.startsWith('cancel')), ['cancel 11', 'cancel 12']);
  assert.equal(r.results.filter((x) => x.step.op === 'wait-run').length, 1);
  assert.equal(r.ok, true);
});

test('an earlier rollback still holding the claim fails this run instead of passing silently', async () => {
  const w = world({ runs: [] });
  w.fallbacks = af.claimFallback({ leases: {} }, { show: SHOW, night: NIGHT, holder: 'rollback:0', now: new Date(NOW).toISOString() }).state;
  const r = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r.ok, false);
  assert.match(r.results.find((x) => x.step.op === 'fallback').note, /re-run in 10 min/);
});

test('a second rollback, or one racing the watchdog, never dispatches twice', async () => {
  const w = world({ runs: [] });
  await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1', hard: true });
  const again = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:2', hard: true });
  assert.equal(again.ok, true);
  assert.equal(w.calls.filter((c) => c.startsWith('dispatch')).length, 1);
  const raced = world({ runs: [] });
  raced.fallbacks = af.claimFallback({ leases: {} }, { show: SHOW, night: NIGHT, holder: 'watchdog:9', now: new Date(NOW).toISOString() }).state;
  const r = await ls.executeRollback(plan(raced), raced.ports, { holder: 'rollback:1', hard: true });
  assert.equal(r.ok, true);
  assert.equal(raced.calls.filter((c) => c.startsWith('dispatch')).length, 0, 'the watchdog is dispatching it');
});

test('outside the press-night window nothing is dispatched; dry-run never waits', async () => {
  const w = world({ inWindow: false });
  const r = await ls.executeRollback(plan(w), w.ports, { holder: 'rollback:1', wait: false });
  assert.equal(r.ok, true);
  assert.equal(w.calls.filter((c) => c.startsWith('dispatch')).length, 0);
  assert.equal(w.clock, NOW, 'dry-run slept');
});

test('drill state and audit row', () => {
  assert.notEqual(ls.DRILL_LEASE_BRANCH, require('../../scripts/lib/opening-night-lane/lease-store.js').DEFAULT_BRANCH);
  assert.notEqual(ls.DRILL_FALLBACK_BRANCH, af.FALLBACK_BRANCH);
  const s = ls.drillLeaseState({ night: NIGHT, now: NOW });
  assert.equal(s.leases[`${ls.DRILL_SHOW}|${NIGHT}`].holder, ls.DRILL_HOLDER);
  assert.ok(!ls.ALLOWED_VARIABLES.includes(ls.PROBE_VARIABLE), 'the probe variable is not switchable');
  const row = ls.auditRow({ action: 'set', mode: 'live', reason: 'owner asked', actor: 'a', triggeringActor: 'b', runId: '5', requestId: 'r1', changes: [{ variable: 'LANE_STANDDOWN', from: '', to: 'all' }], ok: true });
  assert.deepEqual(Object.keys(row).sort(), ['action', 'actor', 'at', 'changes', 'mode', 'ok', 'reason', 'request_id', 'run_id', 'run_url', 'triggering_actor']);
  assert.equal(row.changes[0].from, '');
  assert.deepEqual(oldPathDispatchArgs({ id: 'x', market: 'west-end' }).slice(-2), ['-f', 'market=west-end']);
});

test('CLI refuses before touching anything', () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(repo, 'scripts/lane-switch.js'), ...a], { encoding: 'utf8', env: { ...process.env, VARS_TOKEN: '', GH_TOKEN: '' } });
  assert.equal(run('set', '--variable=ORCHESTRATOR_PAUSED', '--value=x', '--reason=r', '--mode=live').status, 2);
  assert.equal(run('set', '--variable=LANE_STANDDOWN', '--value=all', '--reason=r').status, 2, 'mode has no default');
  assert.equal(run('set', '--variable=LANE_STANDDOWN', '--value=all', '--reason=', '--mode=live').status, 2, 'reason is required');
  assert.equal(run('set', '--variable=LANE_STANDDOWN', '--value=all', '--reason=r', '--mode=drill').status, 2);
  assert.equal(run('rollback', '--reason=r').status, 2);
  assert.equal(run('frobnicate').status, 2);
});

test('workflow wiring', () => {
  const y = read('.github/workflows/opening-night-lane-switch.yml');
  const on = y.slice(y.indexOf('\non:'), y.indexOf('\npermissions:'));
  assert.match(on, /^\s+workflow_dispatch:/m);
  assert.doesNotMatch(on, /schedule:|workflow_run:|push:|pull_request:|repository_dispatch:/);
  const variable = y.slice(y.indexOf('      variable:'), y.indexOf('      value:'));
  assert.match(variable, /options: \[LANE_ONLY_MARKETS, LANE_STANDDOWN\]/);
  const mode = y.slice(y.indexOf('      mode:'), y.indexOf('      show:'));
  assert.doesNotMatch(mode, /^\s+default:/m, 'mode must be named on every dispatch');
  assert.doesNotMatch(y, /^concurrency:/m, 'a newer dispatch must never drop a queued rollback');
  assert.match(y, /VARS_TOKEN: \$\{\{ secrets\.REVIEW_TEXTS_TOKEN \}\}/);
  assert.match(y, /actions: write/);
  assert.match(y, /node scripts\/lane-switch\.js/);
  assert.match(y, /git add data\/audit\/lane-switch\.jsonl/);
  assert.match(y, /push-with-retry\.sh 5 main/);
  assert.match(read('scripts/lane-watchdog.js'), /oldPathDispatchArgs\(show\)/, 'watchdog and rollback start the same old-path run');
});
