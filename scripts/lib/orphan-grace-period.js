'use strict';

/**
 * Pure decision logic for the orphan-slim-show-file self-heal's grace period
 * (BRO-3507 follow-up after adversarial review). Deleting a slim show file
 * the instant it looks orphaned is unsafe: a rename/consolidation publishes
 * the PUBLIC repo change (old id disappears from a rebuild) before the
 * PRIVATE core-data repo's shows.json update lands, or vice versa — the two
 * are checked out independently in the self-heal workflow. A show that's
 * mid-rename looks identically orphaned to one that's been dead for months.
 *
 * Fix: only delete an id once it has looked orphaned for `graceHours`
 * (default 24) STRAIGHT — long enough for any in-flight rename to resolve on
 * its own, since the two repos sync within minutes in the worst case, not
 * hours. An id that stops looking orphaned (found in shows.json again) drops
 * out of the tracked state entirely, so a resolved rename doesn't leave stale
 * grace-period bookkeeping behind.
 */

const GRACE_HOURS_DEFAULT = 24;

/**
 * @param {string[]} currentIds - slim show file ids that look orphaned RIGHT NOW
 * @param {{seen?: Record<string, string>}|null} previousState - prior run's persisted state (seen: id -> ISO first-seen timestamp)
 * @param {number} nowMs
 * @param {number} graceHours
 * @returns {{readyToDelete: string[], newState: {seen: Record<string, string>, updatedAt: string}}}
 */
function updateGraceState(currentIds, previousState, nowMs, graceHours = GRACE_HOURS_DEFAULT) {
  const prevSeen = (previousState && previousState.seen) || {};
  const seen = {};
  const readyToDelete = [];
  const graceMs = graceHours * 60 * 60 * 1000;

  for (const id of currentIds || []) {
    const prevSeenAt = prevSeen[id];
    const firstSeenAtMs = prevSeenAt ? Date.parse(prevSeenAt) : NaN;
    // An unparseable stored timestamp is treated as "just seen" (restart the
    // grace clock) rather than crashing or treating it as infinitely old —
    // corrupt state must never manufacture an instant-delete.
    const effectiveFirstSeenMs = Number.isFinite(firstSeenAtMs) ? firstSeenAtMs : nowMs;
    seen[id] = new Date(effectiveFirstSeenMs).toISOString();
    if (nowMs - effectiveFirstSeenMs >= graceMs) readyToDelete.push(id);
  }
  // Ids present in the OLD state but not in currentIds simply aren't carried
  // into `seen` — they're no longer orphaned (resolved) or no longer exist to
  // track, either way nothing to remember about them.

  return { readyToDelete, newState: { seen, updatedAt: new Date(nowMs).toISOString() } };
}

module.exports = { updateGraceState, GRACE_HOURS_DEFAULT };
