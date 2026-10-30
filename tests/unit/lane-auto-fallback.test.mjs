// BRO-6621 (plan v2 step 6): lane start, watchdog and fallback with no cron on the critical path. Requires the real
// decision functions (scripts/lib/opening-night-lane/auto-fallback.js) and pins the workflow wiring by reading the
// real YAML: the night run self-chains under the 360-minute cap with a per-show concurrency group, the watchdog is a
// separately dispatched self-chaining workflow (never a cron, never a job of the lane run), and the starter is gated
// on LANE_ONLY_MARKETS (the shadow hold).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// 2026-11-12 Broadway opening: embargo 22:00 New York = 2026-11-13T03:00Z. Lane start 02:30Z, watch end 07:30Z.
const SHOW = { id: 'bway-show', market: 'broadway', category: 'broadway', openingDate: '2026-11-12' };
const NIGHT = '2026-11-12';
const KEY = `${SHOW.id}|${NIGHT}`;
const ON = { ok: true, value: 'broadway' };
const UNSET = { ok: true, value: '' };
const NO_STANDDOWN = { ok: true, value: '' };
const iso = (s) => new Date(s).toISOString();
const leaseAt = (heartbeatAt) => ({
  leases: { [KEY]: { holder: 'gha-1', acquiredAt: iso('2026-11-13T02:30:00Z'), heartbeatAt: iso(heartbeatAt),
    expiresAt: new Date(Date.parse(heartbeatAt) + 30 * 60000).toISOString() } },
});
const tick = (over) => af.decideWatchdog({ show: SHOW, night: NIGHT, onlyMarkets: ON, standdown: NO_STANDDOWN,
  laneRun: { status: 'active', createdAt: '2026-11-12T22:00:00Z' }, ...over });

/** In-memory ports for runWatchdogTick; records the order of side effects. */
function fakePorts({ state, laneRun = { status: 'active', createdAt: '2026-11-12T22:00:00Z' }, dispatchOk = true, heartbeatBeforeRelease = false,
  claims = { box: { state: { leases: {} } } }, claimWriteFails = false } = {}) {
  const calls = [];
  const box = { state };
  return {
    calls, box,
    readLeaseState: () => box.state,
    laneRunStatus: () => laneRun,
    readVars: () => ({ onlyMarkets: ON, standdown: NO_STANDDOWN }),
    release: (fn) => {
      calls.push('release');
      if (heartbeatBeforeRelease) box.state = leaseAt('2026-11-13T03:40:00Z');
      const out = fn(box.state);
      if (out.ok) box.state = out.state;
      return out;
    },
    // The fallback-claim branch; share `claims` between two port sets to model two watchdogs for one night.
    claim: (fn) => {
      if (claimWriteFails) { calls.push('claim'); return { ok: false, reason: 'push rejected' }; }
      const out = fn(claims.box.state);
      calls.push(out.ok && out.state.leases[KEY].dispatched ? 'mark' : 'claim');
      if (out.ok) claims.box.state = out.state;
      return out;
    },
    dispatchOldPath: () => { calls.push('dispatch'); return dispatchOk; },
    page: () => calls.push('page'),
  };
}

// ---- watchdog decision (card acceptance) ----

test('fresh lease: the watchdog does nothing', () => {
  const d = tick({ now: '2026-11-13T03:10:00Z', leaseState: leaseAt('2026-11-13T03:05:00Z') });
  assert.equal(d.action, 'wait');
  const ports = fakePorts({ state: leaseAt('2026-11-13T03:05:00Z') });
  const r = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:10:00Z' }, ports);
  assert.equal(r.done, false);
  assert.deepEqual(ports.calls, []);
});

test('lease dead for the 30-min TTL: release first, then exactly one dispatch, then the digest page', () => {
  // Last heartbeat 03:00Z, expired 03:30Z; checked at 03:31Z.
  const d = tick({ now: '2026-11-13T03:31:00Z', leaseState: leaseAt('2026-11-13T03:00:00Z') });
  assert.equal(d.action, 'fallback');
  assert.equal(d.release, true);
  assert.equal(d.digest, true);
  const ports = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z') });
  const r = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:31:00Z', holder: 'watchdog:1' }, ports);
  assert.deepEqual(ports.calls, ['release', 'claim', 'dispatch', 'mark', 'page']);
  assert.equal(r.dispatched, true);
  assert.equal(r.done, true);
  assert.equal(ports.box.state.leases[KEY], undefined, 'the dead lease is gone');
});

test('a lease 29 minutes without a heartbeat is still live: no fallback', () => {
  const d = tick({ now: '2026-11-13T03:29:00Z', leaseState: leaseAt('2026-11-13T03:00:00Z') });
  assert.equal(d.action, 'wait');
});

test('re-check after the fallback makes no second dispatch', () => {
  const ports = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z') });
  const first = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:31:00Z' }, ports);
  assert.equal(first.dispatched, true);
  // The loop carries fallbackDone forward (and the next hop gets fallback_done=true).
  for (const now of ['2026-11-13T03:36:00Z', '2026-11-13T04:31:00Z', '2026-11-13T06:00:00Z']) {
    const again = af.runWatchdogTick({ show: SHOW, night: NIGHT, now, fallbackDone: true }, ports);
    assert.equal(again.action, 'stop');
  }
  assert.deepEqual(ports.calls.filter((c) => c === 'dispatch'), ['dispatch']);
  assert.deepEqual(ports.calls.filter((c) => c === 'release'), ['release']);
});

test('two watchdogs for one night: the claim lets only one dispatch', () => {
  const claims = { box: { state: { leases: {} } } };
  const a = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z'), claims });
  const b = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z'), claims });
  assert.equal(af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:31:00Z', holder: 'watchdog:A' }, a).dispatched, true);
  const rb = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:32:00Z', holder: 'watchdog:B' }, b);
  assert.deepEqual([rb.action, rb.done, rb.dispatched], ['stop', true, undefined]);
  assert.ok(!b.calls.includes('dispatch') && !b.calls.includes('page'));
  // A claim taken but not yet marked dispatched holds another watchdog off for 10 minutes, then is retaken.
  const inFlight = af.claimFallback({ leases: {} }, { show: SHOW.id, night: NIGHT, holder: 'watchdog:A', now: '2026-11-13T03:31:00Z' }).state;
  assert.equal(af.claimFallback(inFlight, { show: SHOW.id, night: NIGHT, holder: 'watchdog:B', now: '2026-11-13T03:35:00Z' }).reason, 'claim-in-flight');
  assert.equal(af.claimFallback(inFlight, { show: SHOW.id, night: NIGHT, holder: 'watchdog:A', now: '2026-11-13T03:36:00Z' }).ok, true);
  assert.equal(af.claimFallback(inFlight, { show: SHOW.id, night: NIGHT, holder: 'watchdog:B', now: '2026-11-13T03:42:00Z' }).ok, true);
  // markFallbackDispatched only for the holder.
  assert.equal(af.markFallbackDispatched(inFlight, { show: SHOW.id, night: NIGHT, holder: 'watchdog:B', now: '2026-11-13T03:32:00Z' }).ok, false);
});

test('a claim that cannot be written waits two ticks, then dispatches anyway on the third', () => {
  const ports = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z'), claimWriteFails: true });
  let claimFailures = 0;
  const actions = [];
  for (const now of ['2026-11-13T03:31:00Z', '2026-11-13T03:36:00Z', '2026-11-13T03:41:00Z']) {
    const r = af.runWatchdogTick({ show: SHOW, night: NIGHT, now, holder: 'watchdog:1', claimFailures }, ports);
    claimFailures = r.claimFailures;
    actions.push(r.dispatched ? 'dispatched' : r.action);
  }
  assert.deepEqual(actions, ['wait', 'wait', 'dispatched']);
  assert.deepEqual(ports.calls.filter((c) => c === 'dispatch'), ['dispatch']);
});

test('a failed dispatch is retried on the next tick without a second page', () => {
  const ports = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z'), dispatchOk: false });
  const r = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:31:00Z', holder: 'watchdog:1' }, ports);
  assert.equal(r.dispatched, false);
  assert.equal(r.done, false);
  assert.deepEqual(ports.calls, ['release', 'claim', 'dispatch']);
  // Same holder retakes its own claim on the next tick and dispatches.
  const again = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:36:00Z', holder: 'watchdog:1' }, { ...ports, dispatchOldPath: () => { ports.calls.push('dispatch'); return true; } });
  assert.equal(again.dispatched, true);
  assert.equal(ports.calls.filter((c) => c === 'page').length, 1);
});

test('the lane heartbeated between the read and the release: refused, no dispatch', () => {
  const ports = fakePorts({ state: leaseAt('2026-11-13T03:00:00Z'), heartbeatBeforeRelease: true });
  const r = af.runWatchdogTick({ show: SHOW, night: NIGHT, now: '2026-11-13T03:41:00Z' }, ports);
  assert.equal(r.action, 'wait');
  assert.deepEqual(ports.calls, ['release']);
  assert.ok(ports.box.state.leases[KEY], 'the live lease is kept');
});

test('releaseDeadLease refuses a live lease, removes an expired one, and is a no-op without one', () => {
  const live = af.releaseDeadLease(leaseAt('2026-11-13T03:20:00Z'), { show: SHOW.id, night: NIGHT, now: '2026-11-13T03:31:00Z' });
  assert.deepEqual([live.ok, live.reason], [false, 'lease-live']);
  const dead = af.releaseDeadLease(leaseAt('2026-11-13T03:00:00Z'), { show: SHOW.id, night: NIGHT, now: '2026-11-13T03:31:00Z' });
  assert.equal(dead.ok, true);
  assert.equal(dead.released, true);
  assert.equal(dead.state.leases[KEY], undefined);
  const none = af.releaseDeadLease({ leases: {} }, { show: SHOW.id, night: NIGHT, now: '2026-11-13T03:31:00Z' });
  assert.deepEqual([none.ok, none.released], [true, false]);
  // Other shows' leases are untouched.
  const other = { leases: { ...leaseAt('2026-11-13T03:00:00Z').leases, 'other|2026-11-12': { holder: 'gha-2', expiresAt: '2026-11-13T09:00:00Z' } } };
  assert.ok(af.releaseDeadLease(other, { show: SHOW.id, night: NIGHT, now: '2026-11-13T03:31:00Z' }).state.leases['other|2026-11-12']);
});

test('no lease: a clean finish stops, a failed run falls back quietly, a run that never claimed falls back with a page', () => {
  const empty = { leases: {} };
  assert.equal(tick({ now: '2026-11-13T05:00:00Z', leaseState: empty, laneRun: { status: 'success' }, leaseSeen: true }).action, 'stop');
  // Green without the lease ever seen: the lane never ran (held, or exited early), so the old path takes the night.
  const neverRan = tick({ now: '2026-11-13T05:00:00Z', leaseState: empty, laneRun: { status: 'success' } });
  assert.deepEqual([neverRan.action, neverRan.digest], ['fallback', true]);
  // A failed run falls back even when the lease state cannot be read (it already went red).
  assert.equal(tick({ now: '2026-11-13T03:00:00Z', leaseState: null, laneRun: { status: 'failure' } }).action, 'fallback');
  // Nothing before lane start, whatever the run says.
  assert.equal(tick({ now: '2026-11-13T02:00:00Z', leaseState: empty, laneRun: { status: 'failure' } }).action, 'wait');
  // A live lease is reported so the loop can carry leaseSeen forward.
  assert.equal(tick({ now: '2026-11-13T03:10:00Z', leaseState: leaseAt('2026-11-13T03:05:00Z') }).leaseLive, true);
  const failed = tick({ now: '2026-11-13T03:00:00Z', leaseState: empty, laneRun: { status: 'failure' } });
  assert.deepEqual([failed.action, failed.release, failed.digest], ['fallback', false, false]);
  // Active but no lease: lane start 02:30Z + 30 min.
  assert.equal(tick({ now: '2026-11-13T02:59:00Z', leaseState: empty }).action, 'wait');
  const stuck = tick({ now: '2026-11-13T03:00:00Z', leaseState: empty });
  assert.deepEqual([stuck.action, stuck.digest], ['fallback', true]);
  // A late-started run is judged from its own creation, not lane start.
  assert.equal(tick({ now: '2026-11-13T03:20:00Z', leaseState: empty, laneRun: { status: 'active', createdAt: '2026-11-13T03:00:00Z' } }).action, 'wait');
  // No run at all: the chain broke.
  assert.equal(tick({ now: '2026-11-13T02:50:00Z', leaseState: empty, laneRun: { status: 'none' } }).action, 'wait');
  assert.equal(tick({ now: '2026-11-13T03:00:00Z', leaseState: empty, laneRun: { status: 'none' } }).action, 'fallback');
  // Unknown lease state or unknown run status never fall back on their own.
  assert.equal(tick({ now: '2026-11-13T04:00:00Z', leaseState: null }).action, 'wait');
  assert.equal(tick({ now: '2026-11-13T04:00:00Z', leaseState: empty, laneRun: { status: 'unknown' } }).action, 'wait');
});

test('window edges: nothing before lane start + TTL, stop after lane end + TTL', () => {
  assert.equal(tick({ now: '2026-11-12T23:00:00Z', leaseState: { leases: {} } }).action, 'wait');
  assert.equal(tick({ now: '2026-11-13T07:30:00Z', leaseState: leaseAt('2026-11-13T03:00:00Z') }).action, 'stop');
  assert.equal(tick({ now: '2026-11-13T07:29:00Z', leaseState: leaseAt('2026-11-13T03:00:00Z') }).action, 'fallback');
});

test('embargo override (BRO-6614 reviewEmbargoAt) moves the watchdog window', () => {
  const early = { ...SHOW, reviewEmbargoAt: '2026-11-13T00:00:00Z' }; // lane start 23:30Z, watch end 04:30Z
  const t = af.nightTimes(early, NIGHT);
  assert.equal(new Date(t.laneStartMs).toISOString(), '2026-11-12T23:30:00.000Z');
  assert.equal(af.decideWatchdog({ show: early, night: NIGHT, now: '2026-11-13T04:30:00Z', leaseState: { leases: {} },
    laneRun: { status: 'active' }, onlyMarkets: ON, standdown: NO_STANDDOWN }).action, 'stop');
  assert.equal(af.decideWatchdog({ show: early, night: NIGHT, now: '2026-11-13T00:00:00Z', leaseState: { leases: {} },
    laneRun: { status: 'active' }, onlyMarkets: ON, standdown: NO_STANDDOWN }).action, 'fallback');
});

test('owner switches: LANE_STANDDOWN or an emptied LANE_ONLY_MARKETS hand the night to the old path without a page', () => {
  const sd = tick({ now: '2026-11-13T03:00:00Z', leaseState: { leases: {} }, standdown: { ok: true, value: 'broadway' } });
  assert.deepEqual([sd.action, sd.digest], ['fallback', false]);
  const unset = tick({ now: '2026-11-13T02:40:00Z', leaseState: { leases: {} }, onlyMarkets: UNSET });
  assert.deepEqual([unset.action, unset.digest], ['fallback', false]);
  // An unread variable is not a switch.
  assert.equal(tick({ now: '2026-11-13T02:40:00Z', leaseState: { leases: {} }, onlyMarkets: { ok: false, value: '' } }).action, 'wait');
});

// ---- starter (S6-T1/T2, shadow hold) ----

const start = (over) => af.planNightStart({ show: SHOW, now: '2026-11-12T20:00:00Z', onlyMarkets: ON, standdown: NO_STANDDOWN,
  armed: true, seenTitles: [], ...over });

test('starter dispatches on opening day when lane-only, armed and not yet started', () => {
  assert.deepEqual(start({}), { start: true, watchdogOnly: false, reason: 'opening day, lane-only, armed', night: NIGHT });
  // Any of the opening-day crons is inside [embargo - 20h, embargo + 1h].
  assert.equal(start({ now: '2026-11-12T07:00:00Z' }).start, true);
  assert.equal(start({ now: '2026-11-13T04:00:00Z' }).start, true);
  assert.equal(start({ now: '2026-11-12T06:59:00Z' }).start, false);
  assert.equal(start({ now: '2026-11-13T04:01:00Z' }).start, false);
});

test('shadow hold: LANE_ONLY_MARKETS unset, unread or a typo never starts night mode', () => {
  for (const onlyMarkets of [UNSET, { ok: false, value: 'broadway' }, { ok: true, value: 'braodway' }, { ok: true, value: 'all' }, { ok: true, value: 'west-end' }]) {
    const d = start({ onlyMarkets });
    assert.equal(d.start, false, JSON.stringify(onlyMarkets));
    assert.match(d.reason, /shadow hold|LANE_ONLY_MARKETS/);
  }
});

test('starter skips LANE_STANDDOWN, unarmed, unreadable run list, and a night already started', () => {
  assert.equal(start({ standdown: { ok: true, value: 'all' } }).start, false);
  assert.equal(start({ standdown: { ok: false, value: '' } }).start, false);
  assert.equal(start({ armed: false }).start, false);
  assert.equal(start({ seenTitles: null }).start, false);
  assert.equal(start({ seenTitles: [af.watchdogRunTitle(SHOW.id, NIGHT)] }).start, false);
  assert.equal(start({ seenTitles: [af.nightRunTitle(SHOW.id, NIGHT), af.watchdogRunTitle(SHOW.id, NIGHT)] }).start, false);
  // The lane run started but its watchdog dispatch failed: start only the watchdog.
  assert.deepEqual([start({ seenTitles: [af.nightRunTitle(SHOW.id, NIGHT)] }).start, start({ seenTitles: [af.nightRunTitle(SHOW.id, NIGHT)] }).watchdogOnly], [true, true]);
  // Another show's runs do not block this one (two shows on one night).
  assert.equal(start({ seenTitles: [af.nightRunTitle('other', NIGHT), af.watchdogRunTitle('other', NIGHT)] }).start, true);
  assert.equal(start({ show: { ...SHOW, openingDate: null } }).start, false);
});

// ---- night-wait self-chain ----

test('night-wait: chain past the job budget, sleep then go inside it, go at start, late after embargo + 1h', () => {
  const w = (now) => af.planNightWait({ show: SHOW, night: NIGHT, now });
  assert.deepEqual(w('2026-11-12T07:00:00Z'), { action: 'sleep-chain', sleepMin: 330, reason: 'lane starts in 1170 min; chaining' });
  assert.equal(w('2026-11-12T21:00:00Z').action, 'sleep-go');
  assert.equal(w('2026-11-12T21:00:00Z').sleepMin, 330);
  assert.equal(w('2026-11-13T02:30:00Z').action, 'go');
  assert.equal(w('2026-11-13T04:00:00Z').action, 'go');
  assert.equal(w('2026-11-13T04:01:00Z').action, 'late');
  assert.ok(af.WAIT_JOB_BUDGET_MIN < 360);
});

// ---- workflow shape ----

/** The text of one top-level job in a workflow file (from its `  name:` line to the next job). */
function jobBlock(text, job) {
  const m = text.match(new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9_-]*:\\n|$)`));
  assert.ok(m, `job ${job} exists`);
  return m[1];
}

test('lane-live: night waits in its own job, self-chains, stays under the cap, and the concurrency group is per show', () => {
  const y = read('.github/workflows/opening-night-lane-live.yml');
  assert.match(y, /concurrency:\n  group: opening-night-lane-live-\$\{\{ inputs\.mode \}\}-\$\{\{ inputs\.show \}\}\n  cancel-in-progress: false/);
  const wait = jobBlock(y, 'night-wait');
  assert.match(wait, /if: inputs\.mode == 'night'/);
  assert.match(wait, /lane-auto-fallback\.js night-wait/);
  assert.match(wait, /gh workflow run opening-night-lane-live\.yml -f mode=night -f show="\$SHOW" -f night="\$NIGHT"/);
  assert.match(wait, /lane-auto-fallback\.js hold-check/);
  assert.match(wait, /3\) echo "go=false"/, 'only exit 3 (held) skips quietly');
  assert.match(wait, /\*\) echo "::error::hold-check failed/, 'any other hold-check failure fails the job');
  assert.match(wait, /actions: write/);
  const night = jobBlock(y, 'night');
  assert.match(night, /needs: night-wait/);
  assert.match(night, /if: inputs\.mode == 'night' && needs\.night-wait\.outputs\.go == 'true'/);
  for (const job of ['night-wait', 'night']) {
    const cap = Number(jobBlock(y, job).match(/\n    timeout-minutes: (\d+)/)[1]);
    assert.ok(cap < 360, `${job} job cap ${cap} < 360`);
  }
  assert.ok(Number(wait.match(/\n    timeout-minutes: (\d+)/)[1]) > af.WAIT_JOB_BUDGET_MIN, 'the longest sleep fits the job');
  assert.ok(!/^\s*schedule:/m.test(y), 'no cron');
});

test('watchdog: dispatch only, never a cron, self-chains, per show-night concurrency, under the cap', () => {
  const y = read('.github/workflows/opening-night-lane-watchdog.yml');
  assert.match(y, /^on:\n  workflow_dispatch:/m);
  assert.ok(!/^\s*schedule:/m.test(y) && !/^\s*cron:/m.test(y), 'never a cron');
  assert.match(y, /run-name: 'Opening-night lane watchdog \$\{\{ inputs\.show \}\} \$\{\{ inputs\.night \}\}'/);
  assert.equal(af.watchdogRunTitle('s', 'n'), 'Opening-night lane watchdog s n');
  assert.match(y, /group: opening-night-lane-watchdog-\$\{\{ inputs\.show \}\}-\$\{\{ inputs\.night \}\}\n  cancel-in-progress: false/);
  assert.match(y, /if: steps\.wd\.outputs\.result == 'chain'[\s\S]*gh workflow run opening-night-lane-watchdog\.yml/);
  assert.match(y, /-f fallback_done=/);
  assert.match(y, /-f lease_seen=/);
  assert.match(y, /LEASE_SEEN: \$\{\{ steps\.wd\.outputs\.lease_seen \}\}/);
  assert.match(y, /if: steps\.wd\.outputs\.result == 'fallback-paged'[\s\S]*?exit 1/);
  assert.match(y, /severity: 'warning'/);
  assert.ok(Number(y.match(/\n    timeout-minutes: (\d+)/)[1]) < 360);
  // The watchdog is not a job inside the lane run.
  assert.ok(!/lane-watchdog\.js/.test(read('.github/workflows/opening-night-lane-live.yml')));
});

test('orchestrator starter: gated on LANE_ONLY_MARKETS, dispatches the night run and the watchdog separately, before the poll loop', () => {
  const y = read('.github/workflows/opening-night-orchestrator.yml');
  const i = y.indexOf('- name: Start lane night + watchdog');
  assert.ok(i > 0);
  assert.ok(i < y.indexOf('- name: Check API budget'), 'before the polling loop');
  const step = y.slice(i, y.indexOf('- name: Check API budget'));
  assert.match(step, /read-actions-variable\.sh "\$NAME"/);
  assert.match(step, /LANE_ONLY_MARKETS unset or unreadable: shadow hold[\s\S]*?exit 0/);
  assert.match(step, /--arm-check/);
  assert.match(step, /lane-auto-fallback\.js start-plan/);
  assert.match(step, /gh workflow run opening-night-lane-live\.yml -f mode=night/);
  assert.match(step, /gh workflow run opening-night-lane-watchdog\.yml/);
  assert.equal(af.nightRunTitle('s', 'n'), 'Opening-night lane night s n');
  assert.match(read('.github/workflows/opening-night-lane-live.yml'), /run-name: 'Opening-night lane \$\{\{ inputs\.mode \}\} \$\{\{ inputs\.show \}\} \$\{\{ inputs\.night \}\}'/);
});
