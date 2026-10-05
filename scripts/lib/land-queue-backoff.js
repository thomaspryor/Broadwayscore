'use strict';

/**
 * land-queue-backoff.js — pure decisions for BRO-4653.
 *
 * land.yml's `land` job and autonomous-merge.yml share the concurrency group
 * `landing`. GitHub keeps ONE pending run per group: a newer pending run
 * cancels the older one. Re-running every evicted Land job the moment it was
 * cancelled (BRO-4246) made the re-runs evict each other, and a landing burst
 * spent the whole attempt budget (MAX_ATTEMPTS) in minutes (2026-10-05:
 * four land refs stranded at attempt 6).
 *
 * So an attempt is spent only when the landing slot is free, and only one per
 * decision: the sweep runs when a Land / Autonomous Merge run completes (the
 * moment the slot frees) and on a cron backstop, re-running at most ONE
 * stranded run, oldest first. While the slot is held it waits; nothing is
 * spent.
 *
 * "Held" is job-level, not run-level: only a Land JOB that is running or
 * pending in `landing` can make ours pending (and only a pending job can be
 * evicted). A Land run still in its Checks job does not hold the slot; if no
 * Land job does, a re-run starts at once and cannot be evicted. Counting
 * Checks-phase runs as busy would starve stranded runs for as long as pushes
 * keep arriving.
 */

const { MAX_ATTEMPTS } = require('./land-retry-on-cancel');

const LANDING_WORKFLOWS = ['land.yml', 'autonomous-merge.yml'];
// Every non-completed run status the runs API filters on.
const IN_FLIGHT_STATUSES = ['in_progress', 'queued', 'pending', 'waiting', 'requested'];
// An in-flight run older than this is stuck (Checks 40m + Land 15m timeouts,
// autonomous-merge 50m, plus queueing); it must not block every sweep.
const STALE_BLOCKER_HOURS = 3;
const MAX_AGE_HOURS = 24;
// Jobs lookups per slot check. A burst holds ~12 land.yml runs in flight at
// once (2026-10-05), and past the cap the slot reads as busy, so it must cover
// every listed run (20 per status) with room to spare.
const MAX_JOB_LOOKUPS = 25;
const MAX_INSPECT = 10;
// BRO-4676: under a sustained burst the slot is never free, so waiting alone
// starves a stranded run (2026-10-05: ~95 min). Once a run has sat cancelled
// this long with the slot busy, it is re-run anyway and competes in the
// pending slot like a fresh push. Measured from the cancel (updated_at), so
// each aged attempt is spaced AGED_RETRY_MINUTES apart.
const AGED_RETRY_MINUTES = 30;
// BRO-4677: the running-only fast path skips aging, but a re-run joining the
// pending seat can still be evicted by a push finishing Checks (each eviction
// spends an attempt). So it spends at most FAST_RETRY_MAX_ATTEMPT attempts per
// run, spaced FAST_RETRY_MINUTES apart; later attempts wait for the aging rule.
const FAST_RETRY_MINUTES = 3;
const FAST_RETRY_MAX_ATTEMPT = 3;

/** The status-filtered listings that find in-flight landing runs. */
function slotQueries(repo) {
  const out = [];
  for (const status of IN_FLIGHT_STATUSES) {
    for (const wf of LANDING_WORKFLOWS) {
      out.push(`repos/${repo}/actions/workflows/${wf}/runs?status=${status}&per_page=20`);
    }
  }
  return out;
}

/**
 * A Land run's Land job is running or waiting in `landing` (Checks done, Land
 * not). Checks done with no Land job listed yet reads as held: it is about to
 * enter the slot.
 */
function landJobInSlot(jobs) {
  const byName = (n) => (jobs || []).find((j) => j.name === n);
  const checks = byName('Checks');
  const land = byName('Land');
  if (!checks || checks.status !== 'completed') return false;
  return !land || land.status !== 'completed';
}

/**
 * One in-flight run's effect on the slot:
 *   'clear'      — completed, the run being retried, or a Land run still in Checks
 *   'stale'      — in flight for over STALE_BLOCKER_HOURS: stuck, ignored
 *   'busy'       — holds or waits for the slot (autonomous-merge holds it for
 *                  its whole run: the group is workflow-level)
 *   'needs-jobs' — a land.yml run; pass its jobs to decide
 */
function inFlightBlocker(run, { jobs, selfRunId, now = Date.now(), staleHours = STALE_BLOCKER_HOURS } = {}) {
  if (!run || run.status === 'completed') return 'clear';
  if (selfRunId && String(run.id) === String(selfRunId)) return 'clear';
  const started = Date.parse(run.run_started_at || run.created_at);
  if (Number.isFinite(started) && now - started > staleHours * 3600 * 1000) return 'stale';
  if (!/(^|\/)land\.yml$/.test(run.path || '')) return 'busy';
  if (jobs === undefined) return 'needs-jobs';
  return landJobInSlot(jobs) ? 'busy' : 'clear';
}

/**
 * BRO-4677: a busy slot is either only RUNNING (one job in `landing`, the
 * pending seat empty) or has a PENDING entrant too. Only a pending entrant can
 * be evicted, and a re-run joining an empty pending seat evicts nobody, so
 * "running only" must not make a stranded run wait. Call for a run that
 * inFlightBlocker called 'busy':
 *   'running' — Land job in_progress, or an in_progress autonomous-merge run
 *   'pending' — everything else, including Checks done with no Land job yet (it
 *               is about to take the slot) and anything unreadable
 */
function slotHolderKind(run, jobs) {
  if (!/(^|\/)land\.yml$/.test((run && run.path) || '')) return run && run.status === 'in_progress' ? 'running' : 'pending';
  const land = (jobs || []).find((j) => j.name === 'Land');
  return land && land.status === 'in_progress' ? 'running' : 'pending';
}

/**
 * The in-flight scan behind the slot verdict (BRO-4677), with jobs lookups
 * injected so it is testable. Stops early only at a PENDING entrant or when
 * the lookup cap is hit (both `pending: true`); `pending: false` only after a
 * full scan that found a running holder; no holder at all → free.
 */
function scanSlot(runs, { jobsOf, selfRunId, now, maxLookups = MAX_JOB_LOOKUPS, onStale = () => {} } = {}) {
  const blocker = (r, why, pending) => ({ busy: true, pending, blockers: [{ id: r.id, branch: r.head_branch, status: r.status, why }] });
  let lookups = 0;
  let running = null;
  for (const run of orderForSlotCheck(runs)) {
    let jobs;
    let v = inFlightBlocker(run, { selfRunId, now });
    if (v === 'needs-jobs') {
      if (lookups >= maxLookups) return blocker(run, 'lookup-cap', true);
      lookups += 1;
      jobs = jobsOf(run.id);
      v = inFlightBlocker(run, { selfRunId, now, jobs });
    }
    if (v === 'busy') {
      if (slotHolderKind(run, jobs) === 'pending') return blocker(run, 'holds-slot', true);
      running = running || blocker(run, 'running', false);
    }
    if (v === 'stale') onStale(run);
  }
  return running || { busy: false, blockers: [] };
}

/**
 * Check the likeliest slot holders first, so a busy slot costs few jobs
 * lookups: autonomous-merge runs (no lookup), then land.yml re-runs (they skip
 * straight to the Land job), then runs not yet running, then oldest started.
 */
function orderForSlotCheck(runs) {
  const key = (r) => [
    /(^|\/)land\.yml$/.test(r.path || '') ? 1 : 0,
    (r.run_attempt || 1) > 1 ? 0 : 1,
    r.status === 'in_progress' ? 1 : 0,
    Date.parse(r.run_started_at || r.created_at) || 0,
  ];
  return [...(runs || [])].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  });
}

/**
 * Cancelled Land runs worth inspecting, oldest first: on a land/** branch, the
 * newest of the listed cancelled runs for that branch, younger than
 * maxAgeHours, attempt budget not spent, and its ref still at the sha the run
 * verified (`refs`: Map or object of branch → sha, from matching-refs). So
 * exhausted, landed and re-pushed runs never sit ahead of a live one.
 */
function pickStrandedCandidates(cancelledRuns, { refs, now = Date.now(), maxAgeHours = MAX_AGE_HOURS, maxAttempts = MAX_ATTEMPTS } = {}) {
  const tipOf = (b) => (refs instanceof Map ? refs.get(b) : (refs || {})[b]);
  const newest = new Map();
  for (const r of cancelledRuns || []) {
    if (!r || r.status !== 'completed' || r.conclusion !== 'cancelled') continue;
    if (!/^land\//.test(r.head_branch || '')) continue;
    const prev = newest.get(r.head_branch);
    if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) newest.set(r.head_branch, r);
  }
  const cutoff = now - maxAgeHours * 3600 * 1000;
  return [...newest.values()]
    .filter((r) => Date.parse(r.created_at) >= cutoff)
    .filter((r) => (r.run_attempt || 1) < maxAttempts)
    .filter((r) => tipOf(r.head_branch) && tipOf(r.head_branch) === r.head_sha)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** A newer Land run exists for the candidate's branch (a re-push or a refusal since): leave it. */
function supersededByNewerRun(candidate, latestForBranch) {
  return Boolean(latestForBranch && candidate && String(latestForBranch.id) !== String(candidate.id));
}

/** Stranded candidates cancelled more than agedMinutes ago, oldest first. */
function pickAgedCandidates(candidates, { now = Date.now(), agedMinutes = AGED_RETRY_MINUTES } = {}) {
  const since = (r) => Date.parse(r.updated_at || r.created_at);
  return (candidates || []).filter((r) => now - since(r) > agedMinutes * 60000)
    .sort((a, b) => since(a) - since(b));
}

/**
 * One sweep decision. `slot` = {busy, blockers} from the in-flight check. Busy (or no
 * verdict) → wait, no attempt spent. Free → the candidates to inspect, oldest
 * first, capped; the caller re-runs the FIRST one decideLandRetry accepts.
 */
function decideSweep({ slot, cancelledRuns, refs, now, maxInspect = MAX_INSPECT } = {}) {
  if (!slot || slot.busy) {
    const blockers = (slot && slot.blockers) || [];
    // Aging (BRO-4676): a busy slot never blocks a run stranded past the threshold.
    // The caller re-runs at most the FIRST accepted candidate, so one per sweep.
    // And never while an earlier re-run is still in flight: sweeps fire on every
    // Land completion, and a second re-run would evict the first from the pending
    // slot (spending its attempt) at sweep speed, not every AGED_RETRY_MINUTES.
    if (slot && slot.rerunInFlight) return { action: 'wait', reason: 'rerun-in-flight', blockers };
    // BRO-4677: busy with NO pending entrant (explicit false; absent = unknown =
    // conservative) → re-run the oldest stranded run now. It takes the empty
    // pending seat and competes like a fresh push; one per sweep, and
    // rerunInFlight above keeps the next sweep from evicting it. Residual race:
    // a push finishing Checks between the scan and the POST contests the seat
    // (same lottery a fresh push runs, one attempt at stake).
    if (slot && slot.pending === false) {
      const since = (r) => Date.parse(r.updated_at || r.created_at);
      const candidates = pickStrandedCandidates(cancelledRuns, { refs, now })
        .filter((r) => (r.run_attempt || 1) <= FAST_RETRY_MAX_ATTEMPT && now - since(r) > FAST_RETRY_MINUTES * 60000)
        .slice(0, maxInspect);
      if (candidates.length) return { action: 'inspect', reason: 'no-pending-slot-busy', candidates, blockers };
    }
    const aged = pickAgedCandidates(pickStrandedCandidates(cancelledRuns, { refs, now }), { now }).slice(0, maxInspect);
    if (slot && aged.length) return { action: 'inspect', reason: 'aged-slot-busy', aged: true, candidates: aged, blockers };
    return { action: 'wait', reason: 'slot-busy', blockers };
  }
  const candidates = pickStrandedCandidates(cancelledRuns, { refs, now }).slice(0, maxInspect);
  if (!candidates.length) return { action: 'idle', reason: 'nothing-stranded' };
  return { action: 'inspect', candidates };
}

module.exports = {
  LANDING_WORKFLOWS, IN_FLIGHT_STATUSES, STALE_BLOCKER_HOURS, MAX_AGE_HOURS, MAX_JOB_LOOKUPS, MAX_INSPECT, AGED_RETRY_MINUTES,
  pickAgedCandidates, scanSlot, FAST_RETRY_MINUTES, FAST_RETRY_MAX_ATTEMPT, slotQueries, landJobInSlot, slotHolderKind, inFlightBlocker, orderForSlotCheck,
  pickStrandedCandidates, supersededByNewerRun, decideSweep,
};
