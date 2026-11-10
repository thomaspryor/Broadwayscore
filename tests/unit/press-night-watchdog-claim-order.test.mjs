// BRO-7160: the press-night watchdog claims -> dispatches -> marks (a failed dispatch is retried, never recorded as
// sent), and decides lane ownership with the full lease-aware decision (a released lane gives the night back).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wd = require('../../scripts/lib/press-night-watchdog.js');
const af = require('../../scripts/lib/opening-night-lane/auto-fallback.js');

const SHOW = { id: 'wanted-2022', category: 'broadway', openingDate: '2026-11-08' }; // Broadway default embargo 03:00Z
const NIGHT = '2026-11-08';
const E = Date.parse('2026-11-09T03:00:00Z');
const M = 60000;
const ID = 'wanted-2022~pnw-score';

/** In-memory stand-in for the fallback branch: each port runs the real pure transition the CLI passes to casTransition. */
function branch(initial = { leases: {} }) {
  let state = initial;
  const calls = [];
  const cas = (name, fn) => { calls.push(name); const out = fn(state); if (out.ok) state = out.state; return out; };
  return { calls, get state() { return state; }, cas };
}
const ports = (b, holder, dispatch) => ({
  claim: () => b.cas('claim', (s) => af.claimFallback(s, { show: ID, night: NIGHT, holder, now: new Date(E + 20 * M).toISOString() })),
  dispatch: () => { b.calls.push('dispatch'); return dispatch(); },
  mark: () => b.cas('mark', (s) => af.markFallbackDispatched(s, { show: ID, night: NIGHT, holder, now: new Date(E + 20 * M).toISOString() })),
  unclaim: () => b.cas('unclaim', (s) => wd.releaseClaim(s, { show: ID, night: NIGHT, holder })),
});
const key = `${ID}|${NIGHT}`;

test('a claim followed by a failed dispatch is never marked dispatched, hands the claim back and is not spent', () => {
  const b = branch();
  const r = wd.claimThenDispatch(ports(b, 'pnw-1', () => { throw new Error('HTTP 502 from gh workflow run'); }));
  assert.deepEqual(b.calls, ['claim', 'dispatch', 'unclaim'], 'no mark after a failed dispatch');
  assert.equal(r.sent, false);
  assert.equal(r.spent, false, 'the caller must undo its once-per-night slot');
  assert.equal(r.unclaimed, true);
  assert.equal(b.state.leases[key], undefined, 'claim handed back');
  // Another watchdog (new holder) can take the stage at once, not only after the 10-min stale window.
  const other = af.claimFallback(b.state, { show: ID, night: NIGHT, holder: 'pnw-2', now: new Date(E + 21 * M).toISOString() });
  assert.equal(other.ok, true);
});

test('the watchdog retries the stage on the next tick after a failed dispatch (state undone)', () => {
  const file = { outletId: 'nytimes', critic: 'Jesse Green', firstSeenAt: new Date(E + 5 * M).toISOString(), includable: true, scoredAt: null };
  const ORCH = { workflow: 'opening-night-orchestrator.yml', status: 'in_progress', displayTitle: `Opening Night Orchestrator targeted ${SHOW.id} (broadway)` };
  const norm = (o) => String(o || '').toLowerCase();
  const tick = (min, state) => wd.evaluateTick({ showId: SHOW.id, embargoMs: E, nowMs: E + min * M, files: [file], coreRows: [], liveRows: [], runs: [ORCH], state, normOutlet: norm });
  const a = tick(21, {});
  const act = a.actions.find((x) => x.type === 'dispatch' && x.stage === 'score');
  assert.ok(act, 'score retry due');
  const r = wd.claimThenDispatch(ports(branch(), 'pnw-1', () => false));
  assert.equal(r.spent, false);
  const undone = wd.undoUnsent({}, a.state, act);
  const b = tick(31, undone);
  assert.ok(b.actions.some((x) => x.type === 'dispatch' && x.stage === 'score'), 'retried next tick');
});

test('a successful dispatch is claimed, dispatched, then marked, in that order', () => {
  const b = branch();
  const r = wd.claimThenDispatch(ports(b, 'pnw-1', () => 'ok'));
  assert.deepEqual(b.calls, ['claim', 'dispatch', 'mark']);
  assert.equal(r.sent, true);
  assert.equal(r.spent, true);
  assert.equal(b.state.leases[key].dispatched, true);
  // A second watchdog sees it as sent and spends its slot without dispatching.
  const b2 = branch(b.state);
  const r2 = wd.claimThenDispatch(ports(b2, 'pnw-2', () => { throw new Error('must not dispatch'); }));
  assert.deepEqual(b2.calls, ['claim']);
  assert.equal(r2.spent, true);
});

test('claim refusals other than already-dispatched are not spent (in flight, unreadable branch, push failed)', () => {
  for (const reason of ['claim-in-flight', 'state-unreadable', 'push-failed', 'cas-contended']) {
    const r = wd.claimThenDispatch({ claim: () => ({ ok: false, reason }), dispatch: () => assert.fail('no dispatch'), mark: () => assert.fail('no mark'), unclaim: () => assert.fail('no unclaim') });
    assert.equal(r.spent, false, reason);
    assert.equal(r.sent, false, reason);
  }
  const thrown = wd.claimThenDispatch({ claim: () => { throw new Error('git fetch failed'); }, dispatch: () => assert.fail('no dispatch'), mark: () => {}, unclaim: () => {} });
  assert.equal(thrown.spent, false);
});

test('releaseClaim only hands back this holder\'s own undispatched claim', () => {
  const at = new Date(E).toISOString();
  const mine = af.claimFallback({ leases: {} }, { show: ID, night: NIGHT, holder: 'pnw-1', now: at }).state;
  assert.equal(wd.releaseClaim(mine, { show: ID, night: NIGHT, holder: 'pnw-2' }).reason, 'other-holder');
  const sent = af.markFallbackDispatched(mine, { show: ID, night: NIGHT, holder: 'pnw-1', now: at }).state;
  assert.equal(wd.releaseClaim(sent, { show: ID, night: NIGHT, holder: 'pnw-1' }).reason, 'dispatched');
  assert.equal(wd.releaseClaim({ leases: {} }, { show: ID, night: NIGHT, holder: 'pnw-1' }).reason, 'gone');
});

test('lane ownership is lease-aware: a released lane gives the night back while LANE_ONLY_MARKETS still names the market', () => {
  const lease = { holder: 'lane-run-1', acquiredAt: new Date(E - 30 * M).toISOString(), heartbeatAt: new Date(E + 59 * M).toISOString(), expiresAt: new Date(E + 89 * M).toISOString() };
  const base = { onlyMarkets: { ok: true, value: 'broadway' }, standdown: { ok: true, value: 'off-broadway' }, show: SHOW, markers: {}, now: E + 60 * M };
  assert.equal(wd.laneOwnership({ ...base, leaseState: { leases: { [`${SHOW.id}|${NIGHT}`]: lease } } }).owns, true, 'live lease: lane owns');
  const released = wd.laneOwnership({ ...base, leaseState: { leases: {} } });
  assert.equal(released.owns, false, 'variable still set, lease released: the watchdog acts');
  assert.match(released.reason, /no live lane lease/);
  const expired = wd.laneOwnership({ ...base, now: E + 120 * M, leaseState: { leases: { [`${SHOW.id}|${NIGHT}`]: lease } } });
  assert.equal(expired.owns, false, 'expired lease (lane crashed): the watchdog acts');
  assert.equal(wd.laneOwnership({ ...base, leaseState: null }).owns, false, 'lease state unknown: fail toward publishing');
  assert.equal(wd.laneOwnership({ ...base, leaseState: { leases: { [`${SHOW.id}|${NIGHT}`]: lease } }, markers: { [`${SHOW.id}__${NIGHT}`]: { holder: 'lane-run-1' } } }).owns, false, 'lane stood down (exit 3)');
});
