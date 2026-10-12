'use strict';

/**
 * land-queue-backoff.js — which stranded Land run the sweep re-runs next.
 *
 * History: land.yml's Land job and autonomous-merge.yml shared ONE concurrency
 * group, `landing`, and GitHub keeps one pending run per group, so queued
 * landings were evicted (cancelled) by newer ones. BRO-4246/4653/4676/4677
 * grew a model of that single seat here (re-run only while it was free, aging,
 * a fast path) so re-runs would not evict each other.
 *
 * BRO-5112 removed the shared seat: the Land job's group is per branch and the
 * fast-forward is serialized by the git-ref landing mutex
 * (scripts/lib/land-mutex.js), so a re-run waits in that queue and evicts
 * nobody. The sweep now just re-runs the oldest stranded run (main-red lanes
 * first), one per sweep. Cancelled Land runs still come from a human cancel
 * (refused by decideLandRetry once work started), a same-branch run queued
 * behind another, and land.yml definitions older than BRO-5112 (a branch cut
 * before it still carries `group: landing`) during the changeover.
 */

const { MAX_ATTEMPTS } = require('./land-retry-on-cancel');
const { isMainRedBranch } = require('./land-admit');

const MAX_AGE_HOURS = 24;
const MAX_INSPECT = 10;
const { PARKED_MAX_ATTEMPTS } = require('./land-mutex');

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
    .sort((a, b) => (isMainRedBranch(b.head_branch) - isMainRedBranch(a.head_branch)) || (Date.parse(a.created_at) - Date.parse(b.created_at)));
}

/** A newer Land run exists for the candidate's branch (a re-push or a refusal since): leave it. */
function supersededByNewerRun(candidate, latestForBranch) {
  return Boolean(latestForBranch && candidate && String(latestForBranch.id) !== String(candidate.id));
}

/**
 * One sweep decision: the stranded candidates to inspect, oldest first,
 * capped; the caller re-runs the FIRST one decideLandRetry accepts.
 */
function decideSweep({ cancelledRuns, refs, now, maxInspect = MAX_INSPECT } = {}) {
  // Prefilter at the parked budget (BRO-5196); decideLandRetry applies the exact one per run.
  const candidates = pickStrandedCandidates(cancelledRuns, { refs, now, maxAttempts: Math.max(MAX_ATTEMPTS, PARKED_MAX_ATTEMPTS) }).slice(0, maxInspect);
  if (!candidates.length) return { action: 'idle', reason: 'nothing-stranded' };
  return { action: 'inspect', candidates };
}

module.exports = { MAX_AGE_HOURS, MAX_INSPECT, pickStrandedCandidates, supersededByNewerRun, decideSweep };
