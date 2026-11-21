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
 * BRO-7758: a pair silent this long is DORMANT (defunct outlet, or a market it
 * never really covered), not a fresh extractor break. A real break alerts at
 * ~45-70d silent (threshold + 2 red weeks), long before this. Pairs only reach
 * it already-dormant (market-pulse anchoring made them eligible late), and each
 * one used to cost a "BSC Daily: outlet-heartbeat red flags" card plus a manual
 * baseline ack (BRO-5435/6698/7447/7656/7667). They are counted, never alerted.
 */
const DORMANT_SILENT_DAYS = 365;

// Relative to the pair's own red threshold: slow outlets (threshold 300-436d)
// only go dormant a full year PAST their threshold, so their first real break
// still alerts (ship-check 2026-11-18).
function isDormantRow(row) {
  const threshold = Number(row && row.thresholdDays);
  const floor = Number.isFinite(threshold) ? threshold + DORMANT_SILENT_DAYS : DORMANT_SILENT_DAYS;
  return Number(row && row.silentDays) >= Math.max(DORMANT_SILENT_DAYS, floor);
}

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
    const dormant = row.status === 'red' && isDormantRow(row);
    next[key] = { redStreak, lastStatus: row.status, lastCheckedAt: nowIso, ...(dormant ? { dormant: true } : {}) };
    // A suppressed-dormant pair that wakes up (silence drops under the dormant
    // line while still red) must still fire its one ACTION.
    if (redStreak >= 2 && !dormant && ((prevEntry.redStreak || 0) < 2 || prevEntry.dormant)) {
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

/**
 * Given this week's heartbeat rows + persisted state + an optional baseline
 * of already-acknowledged outlet×market keys (card #643), split the rows that
 * have crossed the 2-consecutive-red threshold into "new" (not yet
 * acknowledged — should alert) vs "baselined" (owner already knows, stay
 * quiet). Extracted as a pure function so the digest check and its test don't
 * duplicate the redStreak/baseline-membership logic.
 * @param {Array<{outletId, market, silentDays, ...}>} rows this week's outlet-heartbeat.json rows
 * @param {object} state outlet-heartbeat-state.json — { [key]: { redStreak } }
 * @param {Set<string>} [baselineKeys] keys already acknowledged as known-silent
 * @returns {{ actionable: Array, baselinedCount: number, totalCrossedThreshold: number }}
 *   actionable = new (non-baselined) rows crossing the threshold, sorted worst-first
 */
function getActionableOutletRows(rows, state, baselineKeys) {
  const baseline = baselineKeys || new Set();
  const crossedThreshold = rows.filter((r) => (state[`${r.outletId}::${r.market}`]?.redStreak || 0) >= 2);
  const actionable = crossedThreshold
    .filter((r) => !isDormantRow(r))
    .filter((r) => !baseline.has(`${r.outletId}::${r.market}`))
    .sort((a, b) => b.silentDays - a.silentDays);
  const dormantCount = crossedThreshold.filter(isDormantRow).length;
  const baselinedCount = crossedThreshold.filter((r) => !isDormantRow(r) && baseline.has(`${r.outletId}::${r.market}`)).length;
  return {
    actionable,
    dormantCount,
    baselinedCount,
    totalCrossedThreshold: crossedThreshold.length,
  };
}

module.exports = { updateHeartbeatState, getActionableOutletRows, isDormantRow, DORMANT_SILENT_DAYS };
