'use strict';

/**
 * FIFO run-slot gate for gather-reviews.yml (BRO-4859).
 *
 * gather-reviews.yml used to share the static concurrency group
 * `review-texts-backfill-write`. GitHub keeps only ONE pending run per group,
 * so every dispatch that arrived while a run was busy evicted the previous
 * pending one, which ended 'cancelled' without ever starting: 43 of 225
 * dispatches (19%) between 2026-09-24 and 2026-10-08, e.g. run 37750662374
 * (7 shows). The workflow now uses a per-run group, which never evicts, and
 * this gate keeps the old throttle: a run starts its gather jobs only when
 * fewer than `slots` OLDER gather runs are still active. Waiting runs are
 * themselves active, so older waiters block younger ones (first in, first
 * out) and nothing is dropped.
 *
 * Pure logic here; scripts/wait-for-gather-slot.js polls the API and loops.
 */

const ACTIVE = new Set(['in_progress', 'queued', 'waiting', 'requested', 'pending']);

// A run started this long ago is hung, not working: gather's own jobs time out
// well inside it (prepare 200 + shards 75 + aggregators 50 + rebuild). Ignoring it
// keeps one stuck run from holding every younger run until the wait cap.
const STALE_MS = 6 * 3600e3;

/**
 * @param {Array<{id:number, status:string, startedAt?:string}>} runs  gather-reviews.yml runs
 * @param {number} myRunId  this run's github.run_id
 * @returns {Array} active runs dispatched before this one
 */
function olderActiveRuns(runs, myRunId, now = Date.now()) {
  const me = Number(myRunId);
  return (Array.isArray(runs) ? runs : []).filter((r) => {
    if (!r || Number(r.id) >= me || !ACTIVE.has(r.status)) return false;
    const started = Date.parse(r.startedAt || '');
    return !(started && now - started > STALE_MS);
  });
}

/**
 * @returns {{start:boolean, ahead:number[]}} start=true when this run may proceed
 */
function slotDecision(runs, myRunId, slots, now = Date.now()) {
  const n = Math.max(1, Number(slots) || 1);
  const ahead = olderActiveRuns(runs, myRunId, now).map((r) => Number(r.id)).sort((a, b) => a - b);
  return { start: ahead.length < n, ahead };
}

module.exports = { ACTIVE, STALE_MS, olderActiveRuns, slotDecision };
