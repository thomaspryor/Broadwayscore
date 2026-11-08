'use strict';
/**
 * BRO-7167 test bench, step 1: the real embargo of a past press night, read from
 * the exact publish times of its reviews.
 *
 * Grading only. Nothing in the opening-night lane may require this file (it
 * would change the lane code hash and disarm the lane); the lane keeps
 * press-night-record.js defaultEmbargoAt / observedReleaseFromPublish.
 * observed-embargo.test.mjs pins that.
 *
 * Why: the pilot found the recorded or estimated embargo wrong on 2 of 2 nights
 * (A Few Good Men recorded 02:00Z, real 03:00Z; Rocky Horror estimated 02:00Z,
 * real 01:30Z). observedReleaseFromPublish only ever moves an embargo later, so
 * an early lift (Rocky Horror) is never corrected.
 *
 * Method: outlets publish together the minute the embargo lifts. Find the
 * earliest CLUSTER_WINDOW_MIN window holding at least MIN_CLUSTER distinct
 * outlets with an exact publish time, near the estimate. A lone early post
 * (Talkin' Broadway a day early, Culture Sauce two hours early) never forms a
 * cluster on its own. The cluster start is snapped to the nearest quarter hour
 * when it is within SNAP_MIN of one (02:59 or 01:57 -> the hour).
 */

const MIN = 60000;
const MIN_CLUSTER = 3;
const CLUSTER_WINDOW_MIN = 5;
const SEARCH_BEFORE_MIN = 6 * 60;
const SEARCH_AFTER_MIN = 6 * 60;
const SNAP_MIN = 5; // the cluster window: a post a few minutes before the lift still means the quarter hour

const toMs = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/** True when a publish time string carries a clock time and an explicit zone. */
function isExactWithZone(s) {
  return typeof s === 'string' && /\d{1,2}:\d{2}/.test(s) && /([zZ]|[+-]\d{2}:?\d{2})$/.test(s.trim());
}

function snapQuarter(ms) {
  const q = 15 * MIN;
  const near = Math.round(ms / q) * q;
  return Math.abs(near - ms) <= SNAP_MIN * MIN ? near : ms;
}

/**
 * @param {object} p
 * @param {number|null} p.estimateMs  recorded or estimated embargo (UTC ms); bounds the search
 * @param {{outlet?: string, url?: string, publishedTime: string|null}[]} p.publishTimes
 * @param {object} [opts]  { minCluster, windowMin }
 * @returns {{at: string|null, atMs: number|null, source: 'observed-cluster'|'estimate'|'none',
 *   n: number, outlets: string[], shiftMin: number|null}}
 */
function observedEmbargo({ estimateMs = null, publishTimes = [] } = {}, opts = {}) {
  const minCluster = opts.minCluster || MIN_CLUSTER;
  const windowMs = (opts.windowMin || CLUSTER_WINDOW_MIN) * MIN;
  const lo = estimateMs == null ? -Infinity : estimateMs - SEARCH_BEFORE_MIN * MIN;
  const hi = estimateMs == null ? Infinity : estimateMs + SEARCH_AFTER_MIN * MIN;

  // Every exact, zoned time counts (a date-only or zone-less time could be hours
  // off and would fake or break a cluster). A window's size is its number of
  // DISTINCT outlets, so one outlet's second critic or an early post from one
  // outlet neither inflates a cluster nor pulls that outlet out of the real one.
  const pts = [];
  for (const r of publishTimes || []) {
    if (!r || !isExactWithZone(r.publishedTime)) continue;
    const t = toMs(r.publishedTime);
    if (t == null || t < lo || t > hi) continue;
    const key = String(r.outlet || r.url || '').trim().toLowerCase();
    if (key) pts.push({ t, key, outlet: r.outlet || r.url });
  }
  pts.sort((a, b) => a.t - b.t);

  for (let i = 0; i < pts.length; i++) {
    const inWindow = new Map();
    for (let j = i; j < pts.length && pts[j].t - pts[i].t <= windowMs; j++) if (!inWindow.has(pts[j].key)) inWindow.set(pts[j].key, pts[j].outlet);
    if (inWindow.size >= minCluster) {
      const atMs = snapQuarter(pts[i].t);
      return {
        at: new Date(atMs).toISOString(), atMs, source: 'observed-cluster', n: inWindow.size,
        outlets: [...inWindow.values()],
        shiftMin: estimateMs == null ? null : Math.round((atMs - estimateMs) / MIN),
      };
    }
  }
  if (estimateMs == null) return { at: null, atMs: null, source: 'none', n: 0, outlets: [], shiftMin: null };
  return { at: new Date(estimateMs).toISOString(), atMs: estimateMs, source: 'estimate', n: 0, outlets: [], shiftMin: 0 };
}

module.exports = { observedEmbargo, isExactWithZone, MIN_CLUSTER, CLUSTER_WINDOW_MIN };
