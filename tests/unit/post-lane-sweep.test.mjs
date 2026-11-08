// BRO-7160: after the Broadway fast lane releases (about embargo +4h) the press-night clock runs three targeted poller
// sweeps (+4h15, +5h15, +6h15) and a verify (+7h30). These tests require() the real planner, decisions and CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const sweep = require('../../scripts/lib/post-lane-sweep.js');
const { planKicks, confirmKick, kickKey } = require('../../scripts/lib/press-night-clock.js');
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');
const wd = require('../../scripts/lib/press-night-watchdog.js');

const SHOW = 'wanted-2022';
const NIGHT = '2026-11-08';
const E = Date.parse('2026-11-09T03:00:00Z'); // Broadway default embargo 22:00 ET after DST ends
const M = 60000;
const iso = (ms) => new Date(ms).toISOString();
const lease = (expiresMin) => ({ leases: { [`${SHOW}|${NIGHT}`]: { holder: 'lane-run-1', acquiredAt: iso(E - 30 * M), heartbeatAt: iso(E), expiresAt: iso(E + expiresMin * M) } } });
const pollerRun = (createdMin, status = 'completed', conclusion = 'success', show = SHOW) =>
  ({ displayTitle: `Opening Night Poller — ${show}`, createdAt: iso(E + createdMin * M), status, conclusion });

test('the clock plans the sweep slots for a Broadway night at +4h15, +5h15, +6h15 and a verify at +7h30', () => {
  const shows = [{ id: SHOW, openingDate: NIGHT, category: 'broadway', status: 'previews' }];
  const ev = planKicks(shows, E + 60 * M).filter((x) => x.kind.startsWith('sw'));
  assert.deepEqual(ev.map((x) => [x.kind, iso(x.kickAtMs)]), [
    ['sw1', '2026-11-09T07:15:00.000Z'], ['sw2', '2026-11-09T08:15:00.000Z'], ['sw3', '2026-11-09T09:15:00.000Z'], ['swv', '2026-11-09T10:30:00.000Z'],
  ]);
  // Same times as the sweep library (one source of truth each side, pinned together here).
  assert.deepEqual(sweep.planSlots(E).map((s) => [s.kind, s.atIso]), ev.map((x) => [x.kind, iso(x.kickAtMs)]));
  // Each slot has its own fired key; a fired sw1 never hides sw2, and the kick key is untouched.
  const fired = [kickKey(SHOW, NIGHT, 'sw1')];
  assert.equal(planKicks(shows, E + 260 * M, { fired }).find((x) => x.kind.startsWith('sw')).kind, 'sw2');
  assert.equal(confirmKick(shows, E + 255 * M, { showId: SHOW, night: NIGHT, kind: 'sw1' }), 'kick');
  // A late clock still sweeps: sw3 stays plannable to about +12h, then nothing.
  assert.ok(planKicks(shows, E + 700 * M).some((x) => x.kind === 'sw3'));
  assert.ok(!planKicks(shows, E + 725 * M).some((x) => x.kind.startsWith('sw')));
  // Off-Broadway and West End nights get no sweep (the lane is Broadway only).
  assert.ok(!planKicks([{ ...shows[0], category: 'off-broadway' }], E, { categories: ['off-broadway'] }).some((x) => x.kind.startsWith('sw')));
});

test('a sweep slot waits for the lane, dispatches once it releases, and fails toward collecting', () => {
  const base = { showId: SHOW, kind: 'sw1', embargoMs: E, nowMs: E + 255 * M, runs: [], disabled: false };
  assert.equal(sweep.decideSweep({ ...base, leaseState: lease(270) }).action, 'skip', 'live lease: the lane still collects');
  assert.match(sweep.decideSweep({ ...base, leaseState: lease(270) }).reason, /still holds/);
  assert.equal(sweep.decideSweep({ ...base, leaseState: lease(240) }).action, 'dispatch', 'expired lease: released');
  assert.equal(sweep.decideSweep({ ...base, leaseState: { leases: {} } }).action, 'dispatch');
  assert.equal(sweep.decideSweep({ ...base, leaseState: null, runs: null }).action, 'dispatch', 'unreadable inputs never block');
  assert.equal(sweep.decideSweep({ ...base, leaseState: null, disabled: true }).action, 'skip', 'kill switch');
});

test('a slot already swept (a poller run for the show since the slot time, any status) is not dispatched again', () => {
  const base = { showId: SHOW, kind: 'sw2', embargoMs: E, nowMs: E + 320 * M, leaseState: { leases: {} }, disabled: false };
  assert.equal(sweep.decideSweep({ ...base, runs: [pollerRun(316, 'in_progress', null)] }).action, 'skip');
  assert.equal(sweep.decideSweep({ ...base, runs: [pollerRun(260)] }).action, 'dispatch', 'an sw1 run does not cover sw2');
  assert.equal(sweep.decideSweep({ ...base, runs: [pollerRun(318, 'completed', 'success', 'other-show')] }).action, 'dispatch', 'another show');
  assert.equal(sweep.decideSweep({ ...base, runs: [{ displayTitle: 'Opening Night Poller — auto', createdAt: iso(E + 318 * M) }] }).action, 'dispatch', 'an untargeted run');
});

test('the verify slot redispatches once when the last sweep failed or never ran, not while one is running', () => {
  const base = { showId: SHOW, embargoMs: E, nowMs: E + 450 * M, leaseState: { leases: {} }, disabled: false };
  assert.equal(sweep.decideVerify({ ...base, runs: [] }).action, 'redispatch');
  assert.equal(sweep.decideVerify({ ...base, runs: [pollerRun(200)] }).action, 'redispatch', 'a pre-sweep run does not count');
  assert.equal(sweep.decideVerify({ ...base, runs: [pollerRun(380, 'completed', 'failure'), pollerRun(260)] }).action, 'redispatch');
  assert.equal(sweep.decideVerify({ ...base, runs: [pollerRun(380, 'completed', 'cancelled')] }).action, 'redispatch');
  assert.equal(sweep.decideVerify({ ...base, runs: [pollerRun(380)] }).action, 'ok');
  assert.equal(sweep.decideVerify({ ...base, runs: [pollerRun(440, 'in_progress', null)] }).action, 'ok');
  assert.equal(sweep.decideVerify({ ...base, runs: null }).action, 'skip');
});

test('the dispatch is a targeted fast-path SERP poller run, claimed once per show, night and slot', () => {
  assert.deepEqual(sweep.dispatchArgs(SHOW), ['workflow', 'run', 'opening-night-poller.yml', '-f', `show_id=${SHOW}`, '-f', 'fast_path=true', '-f', 'force_serp=true']);
  const id = sweep.claimId(SHOW, 'sw1');
  const holder = sweep.claimHolder(SHOW, NIGHT, 'sw1');
  let state = { leases: {} };
  const cas = (fn) => { const out = fn(state); if (out.ok) state = out.state; return out; };
  const ports = (dispatch) => ({
    claim: () => cas((s) => af.claimFallback(s, { show: id, night: NIGHT, holder, now: iso(E + 255 * M) })),
    dispatch,
    mark: () => cas((s) => af.markFallbackDispatched(s, { show: id, night: NIGHT, holder, now: iso(E + 255 * M) })),
    unclaim: () => cas((s) => wd.releaseClaim(s, { show: id, night: NIGHT, holder })),
  });
  assert.equal(wd.claimThenDispatch(ports(() => { throw new Error('HTTP 502'); })).sent, false);
  assert.equal(state.leases[`${id}|${NIGHT}`], undefined, 'a failed dispatch hands the claim back');
  assert.equal(wd.claimThenDispatch(ports(() => 'ok')).sent, true);
  const again = wd.claimThenDispatch(ports(() => assert.fail('must not dispatch twice')));
  assert.equal(again.sent, false);
  assert.equal(again.spent, true, 'a re-seeded clock sees the slot as done');
  assert.notEqual(sweep.claimId(SHOW, 'sw2'), id, 'each slot has its own claim');
});

test('CLI dry run for a past night prints the slot times and the decision without dispatching', () => {
  const cli = new URL('../../scripts/post-lane-sweep.js', import.meta.url).pathname;
  const out = execFileSync('node', [cli, `--show=${SHOW}`, `--night=${NIGHT}`, '--embargo-at=2026-11-09T03:00:00Z', '--slot=sw1', '--now=2026-11-09T07:16:00Z', '--dry-run'], { encoding: 'utf8' });
  for (const t of ['sw1  2026-11-09T07:15:00.000Z', 'sw2  2026-11-09T08:15:00.000Z', 'sw3  2026-11-09T09:15:00.000Z', 'swv  2026-11-09T10:30:00.000Z']) assert.ok(out.includes(t), t);
  assert.match(out, /DRY RUN: would run gh workflow run opening-night-poller\.yml -f show_id=wanted-2022 -f fast_path=true -f force_serp=true/);
  const off = execFileSync('node', [cli, `--show=${SHOW}`, `--night=${NIGHT}`, '--embargo-at=2026-11-09T03:00:00Z', '--slot=sw2', '--dry-run'], { encoding: 'utf8', env: { ...process.env, POST_LANE_SWEEP_DISABLED: 'true' } });
  assert.match(off, /skip \(POST_LANE_SWEEP_DISABLED/);
  assert.doesNotMatch(off, /would run/);
});

test('press-night-clock.yml runs the sweep for sw* events before the preflight branch, with the kill switch and push permission', () => {
  const y = readFileSync(new URL('../../.github/workflows/press-night-clock.yml', import.meta.url), 'utf8');
  const swAt = y.indexOf('case "$KIND" in sw*)');
  assert.ok(swAt > 0, 'sw* branch');
  assert.ok(swAt < y.indexOf('if [ "$KIND" != "kick" ]'), 'the sweep branch runs before the catch-all preflight branch');
  assert.match(y, /node scripts\/post-lane-sweep\.js --show="\$SHOW" --night="\$NIGHT" --embargo-at="\$EMBARGO" --slot="\$KIND"/);
  assert.match(y, /POST_LANE_SWEEP_DISABLED: \$\{\{ vars\.POST_LANE_SWEEP_DISABLED \}\}/);
  assert.match(y, /^\s+contents: write/m);
  assert.match(y, /configure-git: 'true'/);
});
