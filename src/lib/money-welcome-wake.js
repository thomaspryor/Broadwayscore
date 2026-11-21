'use strict';
/**
 * money-welcome-wake.js (BRO-7704): pure helpers for src/app/api/money-welcome-wake/route.ts.
 * The sign-up page calls the route right after a sign-up is stored. The route starts
 * money-welcome.yml now instead of waiting for GitHub's throttled hourly cron. Nothing sensitive
 * travels in the request: the route reads the sign-up table itself and only dispatches when a
 * recent, unwelcomed, not-unsubscribed row exists, so a stranger calling it cannot cause more than
 * a debounced, idempotent run. The send itself (claim, flood guard, probe skip) is unchanged.
 */

// A row older than this is the hourly cron's job (and a fresh kick would not change its fate).
const WAKE_WINDOW_MS = 30 * 60 * 1000;

/** True when any row is still waiting for its welcome and was created inside the wake window. */
function shouldWake(rows, now = Date.now(), windowMs = WAKE_WINDOW_MS) {
  if (!Array.isArray(rows)) return false;
  return rows.some((r) => {
    if (!r || r.welcomed_at || r.unsubscribed_at) return false;
    const t = Date.parse(r.created_at);
    return Number.isFinite(t) && now - t >= 0 && now - t <= windowMs;
  });
}

/**
 * GitHub list-runs responses for ?status=queued and ?status=pending (a run held by the concurrency group
 * shows as pending). A run in either state has not started reading the table yet, so it will pick the new
 * row up; dispatching another would only be evicted by the concurrency group. An in-progress run may
 * already have read the table, so it does not count.
 */
function hasQueuedRun(...listRunsJsons) {
  return listRunsJsons.some((j) => !!(j && Number(j.total_count) > 0));
}

module.exports = { WAKE_WINDOW_MS, shouldWake, hasQueuedRun };
