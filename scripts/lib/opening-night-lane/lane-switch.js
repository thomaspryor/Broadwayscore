'use strict';
/**
 * BRO-6622 (cutover card 8): the lane switch. Cloud sessions get 403 on repo variables, so LANE_ONLY_MARKETS and
 * LANE_STANDDOWN are set, cleared and rolled back through one workflow_dispatch workflow
 * (.github/workflows/opening-night-lane-switch.yml, CLI scripts/lane-switch.js). This module is the decision part:
 * what a value may be, what a rollback does and in which order, and the audit row.
 * Runbook: docs/opening-night-lane-switch-runbook.md.
 *
 * Rollback order:
 *   1. LANE_STANDDOWN=all. A running night lane sees it at its next heartbeat (10 min), finishes any publish under
 *      way, pushes, and only then releases its lease (opening-night-lane-live.yml: release waits for the push, BRO-6618).
 *      A night run that self-chains or starts later stands down at its hold check; the watchdog reads the night as held.
 *   2. LANE_ONLY_MARKETS deleted: the old path's publish gates (lane-only-markets.js) reopen at once.
 *   3. Wait up to STANDDOWN_WAIT_MIN for each target to clear (no live lease of the holder seen, no in-flight night run).
 *      Cancelling first would cut that clean exit short, so the cancel is only for a lane still holding after the wait,
 *      or when the session passes hard (a hung lane).
 *   4. Cancel the still-running night runs once, then wait up to RUN_WAIT_MIN for them to complete: a cancel still runs
 *      the run's always() push and release, and the lease must not be freed while the lane's files are only local.
 *   5. Release a lease still held, pinned to the holder seen at plan time (auto-fallback.releaseStuckLease). A lease
 *      already gone is success; one that changed hands is left alone and fails the run (re-run the rollback).
 *   6. Inside the press-night window, hand each show-night to the old path once through the watchdog's own claim
 *      (claimFallback on opening-night-lane-fallbacks), so a rollback and a watchdog never both dispatch. Outside the
 *      window nothing is dispatched: with the variables cleared, the regular crons cover the show.
 * Every step runs even when an earlier one failed (a 403 on a variable must not leave a lane holding the night); the run
 * goes red at the end if any step failed.
 */
const af = require('./auto-fallback');
const { parseStanddown } = require('./standdown');

const ALLOWED_VARIABLES = Object.freeze(['LANE_ONLY_MARKETS', 'LANE_STANDDOWN']);
const PROBE_VARIABLE = 'LANE_SWITCH_PROBE'; // drill only: proves VARS_TOKEN can write variables
const KNOWN = 'broadway, west-end, off-broadway, off-west-end, regional, tour';
const OFF_VALUES = new Set(['', 'false', '0', 'off', 'no', 'none']);
const ROLLBACK_STANDDOWN = 'all';
const NIGHT_TITLE_PREFIX = 'Opening-night lane night ';
const MODES = Object.freeze(['live', 'dry-run', 'drill']);
const STANDDOWN_WAIT_MIN = 15; // heartbeat every 10 min + a publish batch to finish
const RUN_WAIT_MIN = 10;       // a cancelled run's always() push + release
const POLL_SEC = 30;
// Drill mode never touches the real lease or fallback branches, LANE_*, runs or the orchestrator.
const DRILL_LEASE_BRANCH = 'opening-night-lane-drill';
const DRILL_FALLBACK_BRANCH = 'opening-night-lane-drill-fallbacks';
const DRILL_SHOW = 'drill-synthetic';
const DRILL_HOLDER = 'drill-lane';

/**
 * Validate a set (value required) or clear request. Any other variable name is refused. LANE_STANDDOWN takes "all" or
 * known markets/categories; LANE_ONLY_MARKETS takes known markets/categories only. A token the parser does not know
 * is refused: in LANE_STANDDOWN it would silently mean "all", in LANE_ONLY_MARKETS nothing.
 * @returns {{ok:true, variable:string, op:'set'|'delete', value:string} | {ok:false, reason:string}} Pure.
 */
function validateSwitch({ action, variable, value }) {
  const name = String(variable == null ? '' : variable).trim();
  if (!ALLOWED_VARIABLES.includes(name)) return { ok: false, reason: `refused: ${name || '(empty)'} is not one of ${ALLOWED_VARIABLES.join(', ')}` };
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (action === 'clear') {
    if (raw) return { ok: false, reason: 'refused: clear takes no value' };
    return { ok: true, variable: name, op: 'delete', value: '' };
  }
  if (action !== 'set') return { ok: false, reason: `refused: unknown action ${action}` };
  if (OFF_VALUES.has(raw)) return { ok: false, reason: `refused: set needs a value (use action clear to remove ${name})` };
  const p = parseStanddown(raw, { unknown: 'ignore' });
  if (name === 'LANE_STANDDOWN' && p.tokens.size === 0 && p.unknown.length === 1 && p.unknown[0] === 'all') {
    return { ok: true, variable: name, op: 'set', value: 'all' };
  }
  if (p.unknown.length) {
    return { ok: false, reason: `refused: ${name} does not take ${p.unknown.join(', ')} (use ${name === 'LANE_STANDDOWN' ? 'all or ' : ''}${KNOWN})` };
  }
  return { ok: true, variable: name, op: 'set', value: [...p.tokens].sort().join(',') };
}

/** "Opening-night lane night SHOW NIGHT" -> {show, night}, else null (smoke, shadow, rehearse runs). Pure. */
function parseNightTitle(title) {
  const t = String(title || '');
  if (!t.startsWith(NIGHT_TITLE_PREFIX)) return null;
  const m = /^(\S+) (\d{4}-\d{2}-\d{2})$/.exec(t.slice(NIGHT_TITLE_PREFIX.length));
  return m ? { show: m[1], night: m[2] } : null;
}

const key = (show, night) => `${show}|${night}`;
const isLive = (entry, nowMs) => !!entry && Date.parse(entry.expiresAt) > nowMs;
const inFlight = (runs, t) => (runs || []).filter((r) => r.status !== 'completed' && (() => {
  const p = parseNightTitle(r.displayTitle); return p && p.show === t.show && p.night === t.night;
})());

/**
 * What the rollback will touch. With show+night: that show-night. Without: every live lease and every in-flight night
 * run (each show-night handled on its own). Pure.
 * @returns {{varSteps:object[], targets:Array<{show,night,holder:string|null,runIds:number[]}>, warnings:string[]}}
 */
function planRollback({ show, night, now, vars, leaseState, laneRuns }) {
  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  if ((show && !night) || (!show && night)) throw new Error('rollback: give both show and night, or neither');
  const warnings = [];
  const varSteps = [];
  const sd = vars && vars.standdown;
  if (!(sd && sd.ok && String(sd.value || '').trim().toLowerCase() === ROLLBACK_STANDDOWN)) {
    varSteps.push({ op: 'set-var', variable: 'LANE_STANDDOWN', from: sd && sd.ok ? (sd.value || '') : 'unknown', to: ROLLBACK_STANDDOWN });
  }
  const om = vars && vars.onlyMarkets;
  if (!(om && om.ok && !String(om.value || '').trim())) {
    varSteps.push({ op: 'delete-var', variable: 'LANE_ONLY_MARKETS', from: om && om.ok ? om.value : 'unknown', to: '' });
  }
  const targets = new Map();
  const target = (s, n) => {
    if (!targets.has(key(s, n))) targets.set(key(s, n), { show: s, night: n, holder: null, runIds: [] });
    return targets.get(key(s, n));
  };
  const wanted = (s, n) => !show || (s === show && n === night);
  if (show) target(show, night);
  if (!Array.isArray(laneRuns)) warnings.push('lane run list unreadable: in-flight runs unknown, re-run the rollback');
  for (const r of laneRuns || []) {
    const t = r.status !== 'completed' && parseNightTitle(r.displayTitle);
    if (t && wanted(t.show, t.night)) target(t.show, t.night).runIds.push(r.databaseId);
  }
  if (!leaseState || leaseState.unknown) warnings.push('lease state unreadable: leases unknown, re-run the rollback');
  for (const [k, entry] of Object.entries((leaseState && !leaseState.unknown && leaseState.leases) || {})) {
    const [s, n] = k.split('|');
    if (wanted(s, n) && isLive(entry, nowMs)) target(s, n).holder = entry.holder;
  }
  if (!targets.size) warnings.push('no live lease, in-flight night run or named show: only the variables change');
  return { varSteps, targets: [...targets.values()], warnings };
}

/**
 * Run the rollback. Every step runs; each result is recorded.
 * @param {{varSteps, targets}} plan
 * @param {object} ports setVar(name,value), deleteVar(name), readLeaseState(), listNightRuns(), cancelRun(id),
 *   release(fn), claim(fn), dispatchOldPath(showId), inWindow(showId, night, nowMs), sleep(ms), now(), log(s).
 *   Var/cancel ports return {ok, detail?}; release/claim return lease-store results; dispatch returns boolean.
 * @param {{holder:string, hard?:boolean, wait?:boolean, standdownWaitMin?, runWaitMin?, pollSec?}} opts
 *   holder = this rollback's fallback-claim name. wait=false (dry-run) skips the waits and reports what would follow.
 * @returns {Promise<{ok:boolean, results:Array<{step:object, ok:boolean, note:string}>}>}
 */
async function executeRollback(plan, ports, opts) {
  const { holder, hard = false, wait = true, standdownWaitMin = STANDDOWN_WAIT_MIN, runWaitMin = RUN_WAIT_MIN, pollSec = POLL_SEC } = opts;
  const log = ports.log || (() => {});
  const results = [];
  const record = (step, ok, note) => { results.push({ step, ok, note }); log(`${ok ? 'ok  ' : 'FAIL'} ${describeStep(step)}: ${note}`); };
  const guard = async (step, fn) => { try { await fn(); } catch (e) { record(step, false, `threw: ${String(e && e.message).slice(0, 160)}`); } };

  for (const step of plan.varSteps) {
    await guard(step, () => {
      const r = step.op === 'set-var' ? ports.setVar(step.variable, step.to) : ports.deleteVar(step.variable);
      record(step, !!r.ok, r.ok ? `was "${step.from}"` : `failed (${r.detail || 'unknown'})`);
    });
  }

  // A target is clear when the holder seen at plan time no longer holds a live lease and no night run is in flight.
  const observe = () => ({ leases: ports.readLeaseState(), runs: ports.listNightRuns() });
  const isClear = (t, o) => {
    const leases = o.leases && !o.leases.unknown ? (o.leases.leases || {}) : null;
    const entry = leases && leases[key(t.show, t.night)];
    const held = leases === null || (isLive(entry, ports.now()) && (!t.holder || entry.holder === t.holder));
    const running = o.runs === null || inFlight(o.runs, t).length > 0;
    return !held && !running;
  };
  const pollUntil = async (cond, capMin) => {
    const end = ports.now() + capMin * 60000;
    for (;;) {
      const o = observe();
      if (cond(o)) return { done: true, o };
      if (ports.now() >= end) return { done: false, o };
      await ports.sleep(pollSec * 1000);
    }
  };

  let pending = plan.targets.filter((t) => t.holder || t.runIds.length);
  if (pending.length && !hard) {
    const step = { op: 'wait-standdown', minutes: standdownWaitMin, targets: pending.map((t) => key(t.show, t.night)) };
    if (!wait) record(step, true, 'dry run: would wait for the lane to stand down by itself');
    else {
      await guard(step, async () => {
        const w = await pollUntil((o) => pending.every((t) => isClear(t, o)), standdownWaitMin);
        const still = pending.filter((t) => !isClear(t, w.o));
        record(step, true, still.length ? `still holding after ${standdownWaitMin} min: ${still.map((t) => key(t.show, t.night)).join(', ')}` : 'the lane stood down and released');
        pending = still;
      });
    }
  }

  for (const t of pending) {
    const o = wait ? observe() : { runs: t.runIds.map((id) => ({ databaseId: id, displayTitle: `${NIGHT_TITLE_PREFIX}${t.show} ${t.night}`, status: 'in_progress' })) };
    const runIds = o.runs === null ? t.runIds : inFlight(o.runs, t).map((r) => r.databaseId);
    for (const id of runIds) {
      const step = { op: 'cancel-run', runId: id, show: t.show, night: t.night };
      await guard(step, () => { const r = ports.cancelRun(id); record(step, !!r.ok, r.ok ? 'cancel requested' : `cancel failed (${r.detail || 'unknown'})`); });
    }
    if (runIds.length) {
      const step = { op: 'wait-run', minutes: runWaitMin, show: t.show, night: t.night };
      if (!wait) record(step, true, 'dry run: would wait for the cancelled run to push and release');
      else {
        await guard(step, async () => {
          const w = await pollUntil((x) => x.runs !== null && inFlight(x.runs, t).length === 0, runWaitMin);
          record(step, true, w.done ? 'run completed' : `run still not completed after ${runWaitMin} min; releasing anyway`);
        });
      }
    }
    if (t.holder) {
      const step = { op: 'release-lease', show: t.show, night: t.night, holder: t.holder };
      await guard(step, () => {
        const r = ports.release((s) => af.releaseStuckLease(s, { show: t.show, night: t.night, holder: t.holder }));
        if (r.ok) record(step, true, r.released === false ? 'would release' : `released lease of ${t.holder}`);
        else if (r.reason === 'lease-gone') record(step, true, 'lease already gone (the lane released it)');
        else if (r.reason === 'other-holder') record(step, false, `lease now held by ${r.holder}, left alone: re-run the rollback`);
        else record(step, false, `release failed (${r.reason})`);
      });
    }
  }

  for (const t of plan.targets) {
    const step = { op: 'fallback', show: t.show, night: t.night };
    await guard(step, () => {
      if (!ports.inWindow(t.show, t.night, ports.now())) {
        record(step, true, 'outside the press-night window: not dispatched, the regular crons cover the show');
        return;
      }
      record(step, ...fallbackOnce(step, ports, { holder, now: new Date(ports.now()).toISOString() }));
    });
  }
  return { ok: results.every((r) => r.ok), results };
}

/** Claim the night like the watchdog does, dispatch the old path once, mark the claim dispatched. -> [ok, note] */
function fallbackOnce(step, ports, { holder, now }) {
  const args = { show: step.show, night: step.night, holder, now };
  const c = ports.claim((s) => af.claimFallback(s, args));
  if (!c.ok && c.reason === 'already-dispatched') return [true, `old path already dispatched by ${c.holder}; no second dispatch`];
  if (!c.ok && c.reason === 'claim-in-flight') return [true, `watchdog ${c.holder} is dispatching the old path now; no second dispatch`];
  // A claim that cannot be written dispatches anyway: a duplicate old-path run is cheaper than none (watchdog rule).
  if (!ports.dispatchOldPath(step.show)) return [false, 'old-path dispatch failed: re-run the rollback'];
  if (!c.ok) return [true, `old path dispatched without a claim (${c.reason})`];
  const m = ports.claim((s) => af.markFallbackDispatched(s, args));
  return [true, m.ok ? 'old path dispatched once (claim marked)' : `old path dispatched; claim not marked (${m.reason})`];
}

function describeStep(s) {
  switch (s.op) {
    case 'set-var': return `set ${s.variable}=${s.to}`;
    case 'delete-var': return `delete ${s.variable}`;
    case 'wait-standdown': return `wait up to ${s.minutes} min for ${s.targets.join(', ')} to stand down`;
    case 'cancel-run': return `cancel night run ${s.runId} (${s.show} ${s.night})`;
    case 'wait-run': return `wait up to ${s.minutes} min for ${s.show} ${s.night}'s cancelled run to finish`;
    case 'release-lease': return `release lease ${s.show}|${s.night} held by ${s.holder}`;
    case 'fallback': return `hand ${s.show} ${s.night} to the old path`;
    default: return s.op;
  }
}

/**
 * The switch calls that put the variables back as they were before a rollback ("unknown" ones are left out). Pure.
 * @returns {string[]} one line per variable, e.g. 'set LANE_ONLY_MARKETS=broadway' or 'clear LANE_STANDDOWN'
 */
function restoreCalls(varSteps) {
  return varSteps.filter((s) => s.from !== 'unknown').map((s) => (s.from ? `set ${s.variable}=${s.from}` : `clear ${s.variable}`));
}

/** One data/audit/lane-switch.jsonl row. Pure. */
function auditRow({ at, action, mode, reason, actor, triggeringActor, runId, runUrl, requestId, changes, ok }) {
  return {
    at: at || new Date().toISOString(), action, mode, ok: !!ok, reason: String(reason || ''),
    actor: actor || null, triggering_actor: triggeringActor || null, run_id: runId || null, run_url: runUrl || null,
    request_id: requestId || null, changes: (changes || []).map((c) => ({ ...c })),
  };
}

/** Lease state with one live synthetic lease, for the drill branch. Pure. */
function drillLeaseState({ night, now }) {
  const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
  const at = new Date(nowMs).toISOString();
  return { leases: { [key(DRILL_SHOW, night)]: { holder: DRILL_HOLDER, acquiredAt: at, heartbeatAt: at, expiresAt: new Date(nowMs + af.LEASE_TTL_MIN * 60000).toISOString() } } };
}

module.exports = {
  ALLOWED_VARIABLES, PROBE_VARIABLE, ROLLBACK_STANDDOWN, MODES, STANDDOWN_WAIT_MIN, RUN_WAIT_MIN, POLL_SEC,
  DRILL_LEASE_BRANCH, DRILL_FALLBACK_BRANCH, DRILL_SHOW, DRILL_HOLDER,
  validateSwitch, parseNightTitle, planRollback, executeRollback, describeStep, restoreCalls, auditRow, drillLeaseState,
};
