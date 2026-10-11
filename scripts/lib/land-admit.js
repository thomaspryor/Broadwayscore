'use strict';

/**
 * land-admit.js — pure decisions for BRO-5096 (main-red fixes starved in the
 * one-pending `landing` queue).
 *
 * GitHub keeps ONE pending job per concurrency group, so every newer Land job
 * evicts the older pending one. On 2026-10-11 BRO-5079 (the fix that turns
 * main green) was evicted 3x in 3h by ordinary lanes while main stayed red.
 *
 * land.yml's `admit` job sits between Checks and Land. An ORDINARY lane waits
 * there while a main-red fix lane is on its way to (or waiting for) the seat,
 * so it never takes the pending seat and never evicts the fix. A main-red
 * lane (branch `land/**main-red**`, e.g. land/main-red-bro-5079) is admitted
 * at once. Everything is fail-open: a deadline, an unreadable listing or any
 * error admits the lane (today's behaviour), so admit can never deadlock the
 * queue. The sweep (land-queue-backoff.decideSweep) reuses isMainRedBranch so
 * it never evicts a pending main-red lane with an ordinary re-run.
 */

const POLL_SECONDS = 60;
const DEADLINE_MINUTES = 20; // < the job's 25-min timeout: admit exits 0 itself
// A main-red run older than this is stuck or abandoned; it must not hold the queue.
const PRIORITY_STALE_HOURS = 3;

const isMainRedBranch = (branch) => /^land\/.*main-red/i.test(branch || '');

/**
 * Is `run` (a land.yml run from the runs listing) a main-red lane that still
 * needs the landing seat?
 *   - not finished (Checks running, waiting in the seat, or landing), or
 *   - cancelled (evicted/stranded) and the newest run for its branch.
 */
function isPriorityLaneActive(run, { newestIdForBranch, now = Date.now() } = {}) {
  if (!run || !isMainRedBranch(run.head_branch)) return false;
  const since = Date.parse(run.updated_at || run.created_at);
  if (Number.isFinite(since) && now - since > PRIORITY_STALE_HOURS * 3600 * 1000) return false;
  if (run.status !== 'completed') return true;
  if (run.conclusion !== 'cancelled') return false;
  return !newestIdForBranch || String(newestIdForBranch.get(run.head_branch)) === String(run.id);
}

/**
 * One admit decision. `runs` = a land.yml runs listing (any statuses),
 * `selfRunId` = this run. Returns {admit, reason}.
 */
function decideAdmit({ selfBranch, selfRunId, runs, now = Date.now() } = {}) {
  if (isMainRedBranch(selfBranch)) return { admit: true, reason: 'main-red-priority' };
  if (!Array.isArray(runs)) return { admit: true, reason: 'listing-unreadable-fail-open' };
  const newest = new Map();
  for (const r of runs) {
    const prev = newest.get(r.head_branch);
    if (!prev || Date.parse(r.created_at) > Date.parse(prev.created_at)) newest.set(r.head_branch, r);
  }
  const newestIdForBranch = new Map([...newest].map(([b, r]) => [b, r.id]));
  const ahead = runs.filter((r) => String(r.id) !== String(selfRunId) && isPriorityLaneActive(r, { newestIdForBranch, now }));
  if (ahead.length) return { admit: false, reason: 'main-red-lane-ahead', ahead: ahead.map((r) => ({ id: r.id, branch: r.head_branch, status: r.status, conclusion: r.conclusion })) };
  return { admit: true, reason: 'no-main-red-lane-ahead' };
}

module.exports = { POLL_SECONDS, DEADLINE_MINUTES, PRIORITY_STALE_HOURS, isMainRedBranch, isPriorityLaneActive, decideAdmit };
