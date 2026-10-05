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
 * stranded run, oldest first. While anything is in flight it waits; nothing
 * is spent.
 */

const { MAX_ATTEMPTS } = require('./land-retry-on-cancel');

const LANDING_WORKFLOWS = ['land.yml', 'autonomous-merge.yml'];
// Every non-completed run status the runs API filters on. A Land run whose
// Checks job is still running reports in_progress and will queue a Land job
// that evicts ours, so in_progress counts as busy too (conservative).
const IN_FLIGHT_STATUSES = ['in_progress', 'queued', 'pending', 'waiting', 'requested'];
const MAX_AGE_HOURS = 24;
// Jobs lookups per sweep. Landed and superseded runs are dropped for free by
// the matching-refs pre-filter, so the few left are nearly always eligible.
const MAX_INSPECT = 5;

/** The status-filtered listings that decide "slot busy", cheapest-first. */
function slotQueries(repo) {
  const out = [];
  for (const status of IN_FLIGHT_STATUSES) {
    for (const wf of LANDING_WORKFLOWS) {
      out.push(`repos/${repo}/actions/workflows/${wf}/runs?status=${status}&per_page=5`);
    }
  }
  return out;
}

/**
 * Is the landing slot busy? `runs` = the workflow_runs those listings
 * returned. `selfRunId` (the run a targeted --run retry is about) never
 * counts against itself.
 */
function landingSlotBusy(runs, { selfRunId } = {}) {
  const blockers = (runs || [])
    .filter((r) => r && r.status !== 'completed' && String(r.id) !== String(selfRunId || ''))
    .map((r) => ({ id: r.id, branch: r.head_branch, status: r.status }));
  return { busy: blockers.length > 0, blockers };
}

/**
 * Cancelled Land runs worth inspecting, oldest first. A run qualifies when its
 * land/** ref still exists at the sha the run verified (`refs`: Map or object
 * of branch → sha, from git/matching-refs/heads/land/), it is the newest
 * listed run for that branch, it is younger than maxAgeHours, and its attempt
 * budget is not spent. Exhausted, landed and superseded runs therefore never
 * sit ahead of a live one.
 */
function pickStrandedCandidates(landRuns, { refs, now = Date.now(), maxAgeHours = MAX_AGE_HOURS, maxAttempts = MAX_ATTEMPTS } = {}) {
  const tipOf = (b) => (refs instanceof Map ? refs.get(b) : (refs || {})[b]);
  const newest = new Map();
  for (const r of landRuns || []) {
    if (!r || !/^land\//.test(r.head_branch || '')) continue;
    const prev = newest.get(r.head_branch);
    if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) newest.set(r.head_branch, r);
  }
  const cutoff = now - maxAgeHours * 3600 * 1000;
  return [...newest.values()]
    .filter((r) => r.status === 'completed' && r.conclusion === 'cancelled')
    .filter((r) => Date.parse(r.created_at) >= cutoff)
    .filter((r) => (r.run_attempt || 1) < maxAttempts)
    .filter((r) => tipOf(r.head_branch) && tipOf(r.head_branch) === r.head_sha)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/**
 * One sweep decision. `slot` = landingSlotBusy's verdict. Busy → wait (no
 * attempt spent). Free → the candidates to inspect, oldest first, capped; the
 * caller re-runs the FIRST one decideLandRetry accepts and stops.
 */
function decideSweep({ slot, landRuns, refs, now, maxInspect = MAX_INSPECT } = {}) {
  if (!slot || slot.busy) return { action: 'wait', reason: 'slot-busy', blockers: (slot && slot.blockers) || [] };
  const candidates = pickStrandedCandidates(landRuns, { refs, now }).slice(0, maxInspect);
  if (!candidates.length) return { action: 'idle', reason: 'nothing-stranded' };
  return { action: 'inspect', candidates };
}

module.exports = {
  LANDING_WORKFLOWS, IN_FLIGHT_STATUSES, MAX_AGE_HOURS, MAX_INSPECT,
  slotQueries, landingSlotBusy, pickStrandedCandidates, decideSweep,
};
