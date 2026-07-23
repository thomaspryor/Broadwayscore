'use strict';

/**
 * S4-T2 — outlet heartbeat alert-state: digest-first, ACTION only after 2
 * consecutive red weeks (this audit runs weekly, so "2 consecutive runs" ==
 * "2 consecutive weeks"). A single red run is noise — false alarms in
 * seasonal lulls are exactly what outlet-cadence.js's market-pulse anchoring
 * already guards against, but this adds a second layer: even a genuine miss
 * gets one silent week before it becomes an email, so a same-week self-heal
 * (the outlet resumes, or the extractor gets fixed) never pages anyone.
 */

/**
 * Advance the per-(outlet,market) red-streak state by one run.
 * @param {object} prevState { [key]: { redStreak, lastStatus, lastCheckedAt } }
 * @param {Array<{outletId, market, status}>} cadenceRows this run's outlet-cadence.js rows
 * @param {string} nowIso
 * @returns {{ state: object, newlyActionable: Array }} newlyActionable = rows that JUST
 *   crossed the 2-consecutive-red threshold this run (fires once per red streak, not every week)
 */
function updateHeartbeatState(prevState, cadenceRows, nowIso) {
  const prev = prevState || {};
  const next = {};
  const newlyActionable = [];
  const seen = new Set();
  for (const row of cadenceRows) {
    const key = `${row.outletId}::${row.market}`;
    seen.add(key);
    const prevEntry = prev[key] || { redStreak: 0 };
    const redStreak = row.status === 'red' ? (prevEntry.redStreak || 0) + 1 : 0;
    next[key] = { redStreak, lastStatus: row.status, lastCheckedAt: nowIso };
    if (redStreak >= 2 && (prevEntry.redStreak || 0) < 2) {
      newlyActionable.push({ ...row, redStreak });
    }
  }
  // Carry forward entries a transient data gap dropped from this run's rows
  // (e.g. a partial reviews.json read) unchanged — don't silently delete or
  // reset an in-progress red streak just because this run's corpus snapshot
  // didn't include the pair (ship-check finding, 2026-07-23).
  for (const [key, entry] of Object.entries(prev)) {
    if (!seen.has(key)) next[key] = entry;
  }
  return { state: next, newlyActionable };
}

module.exports = { updateHeartbeatState };
