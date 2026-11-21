'use strict';

// Pure decision logic for scripts/cyrus-webhook-drain.js's poll loop. Extracted
// so the idle-backoff schedule (2s->4->8->16->20s while the queue is empty,
// instant reset to 2s on real traffic) has a colocated test instead of only a
// manual one-off check (BRO-4375: the relay's GET /api/drain calls Vercel Blob
// list() every poll, billed as an "advanced operation" — fixed polling burned
// ~1.3M list() calls/month for an almost-always-empty queue).

/**
 * @param {number} processed items handled by the last successful drainOnce()
 * @param {number} idle the current idle-sleep value (ms)
 * @param {number} intervalMs the base/active poll interval (ms)
 * @param {number} idleMaxMs the idle-sleep cap (ms)
 * @returns {number} next idle-sleep value (ms)
 */
function nextIdleOnSuccess(processed, idle, intervalMs, idleMaxMs) {
  return processed > 0 ? intervalMs : Math.min(Math.max(idle, intervalMs) * 2, idleMaxMs);
}

/** Sleep duration for the next poll, given this iteration's backoff and idle values. */
function nextSleepMs(backoff, idle) {
  return Math.max(backoff, idle);
}

module.exports = { nextIdleOnSuccess, nextSleepMs };
