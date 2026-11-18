'use strict';
/**
 * press-night-coverage.js (BRO-7779): which collectors run for a show's press night, and the longest stretch with none.
 * Pure: no network, no clock. Built only from the real planners so a timing change anywhere shows up here:
 *   - press-night-clock.js planKicks + kindAction: every clock event and what the workflow does with it
 *     (a targeted orchestrator run polls for ORCH_RUN_MIN, its loop DEADLINE; a sweep is one short poller run);
 *   - auto-fallback.js planNightWait / nightTimes: when the lane night run (started by an orchestrator run inside
 *     the lane start window) wakes, and how long its window lasts.
 * A preflight or a probe collects nothing (the probe only measures), so neither counts.
 *
 * tests/unit/press-night-coverage-gaps.test.mjs drives this for every lane market and asserts no stretch longer than
 * MAX_GAP_MIN without a collector between laneStart - 3h and embargo + 6h. Before BRO-7779 Broadway had nothing
 * before embargo -2h and a 70-minute hole between the lane's end (+185) and the first sweep (+255), and the other
 * markets had no collector from the clock at all.
 */

const clock = require('./press-night-clock');
const af = require('./opening-night-lane/auto-fallback');

const MIN = 60000;
const ORCH_RUN_MIN = clock.ORCH_RUN_MIN; // opening-night-orchestrator.yml loop DEADLINE (start + 240 min)
const SWEEP_RUN_MIN = 10; // one targeted poller run (fast_path)
const MAX_GAP_MIN = 15;
const BEFORE_LANE_MIN = 180; // the card's window: laneStart - 3h ...
const AFTER_EMBARGO_MIN = 360; // ... to embargo + 6h

/**
 * Collector intervals for one show-night: [{fromMs, toMs, who}].
 * @param {object} show  shows.json row (openingDate, category, optional reviewEmbargoAt)
 * @param {{preembargo?:boolean, laneRuns?:boolean, categories?:string[]}} opts  laneRuns false = the lane never starts
 *        (not armed, stood down, not in LANE_ONLY_MARKETS): the old path must cover alone.
 */
function collectorsFor(show, { preembargo = false, laneRuns = true, categories = clock.DEFAULT_CATEGORIES } = {}) {
  const night = show && show.openingDate;
  const t = show && af.nightTimes(show, night, { preembargo });
  if (!t) return { times: null, intervals: [] };
  const kicks = clock.planKicks([show], t.embargoMs - 2 * 24 * 60 * MIN, { categories });
  const intervals = [];
  for (const k of kicks) {
    const a = clock.kindAction(k.kind, k.category);
    if (a.action === 'orchestrator') {
      // The workflow's dedupe and loop length, from the same functions it calls.
      const starts = intervals.filter((i) => i.who.startsWith('orchestrator:')).map((i) => i.fromMs);
      if (clock.dedupedBy(k.kind, k.kickAtMs, starts)) continue;
      intervals.push({ fromMs: k.kickAtMs, toMs: k.kickAtMs + clock.runMinutes(k.kind, t.embargoMs, k.kickAtMs) * MIN, who: `orchestrator:${k.kind}` });
    }
    else if (a.action === 'sweep') intervals.push({ fromMs: k.kickAtMs, toMs: k.kickAtMs + SWEEP_RUN_MIN * MIN, who: `sweep:${k.kind}` });
  }
  if (laneRuns) {
    // The lane night run is dispatched by the first orchestrator run that is up while the start window is open; it
    // then sleeps (planNightWait) to the lane start. No orchestrator run in that window = no lane.
    const windowMin = (t.watchEndMs - t.laneStartMs) / MIN - af.LEASE_TTL_MIN;
    const starters = intervals.filter((i) => i.who.startsWith('orchestrator:')).sort((a, b) => a.fromMs - b.fromMs);
    let wakeMs = null;
    for (const o of starters) {
      for (let now = o.fromMs; now < o.toMs && wakeMs == null; now += 5 * MIN) {
        if (now < t.embargoMs - af.START_BEFORE_MIN * MIN) continue;
        if (now > t.embargoMs + af.START_AFTER_MIN * MIN) break;
        let at = now;
        for (let hop = 0; hop < 20; hop++) {
          const w = af.planNightWait({ show, night, now: at, preembargo });
          if (w.action === 'go') { wakeMs = at; break; }
          if (w.action === 'sleep-go') { wakeMs = at + w.sleepMin * MIN; break; }
          if (w.action === 'sleep-chain') { at += w.sleepMin * MIN; continue; }
          break;
        }
      }
      if (wakeMs != null) break;
    }
    if (wakeMs != null) intervals.push({ fromMs: wakeMs, toMs: t.laneStartMs + windowMin * MIN, who: 'lane' });
  }
  return { times: t, intervals: intervals.sort((a, b) => a.fromMs - b.fromMs) };
}

/** The longest stretch inside [fromMs, toMs] that no interval covers: {gapMin, fromMs, toMs}. */
function maxGap(intervals, fromMs, toMs) {
  const xs = [...intervals].filter((i) => i.toMs > fromMs && i.fromMs < toMs).sort((a, b) => a.fromMs - b.fromMs);
  let best = { gapMin: 0, fromMs, toMs: fromMs };
  let cursor = fromMs;
  const consider = (a, b) => { if ((b - a) / MIN > best.gapMin) best = { gapMin: (b - a) / MIN, fromMs: a, toMs: b }; };
  for (const i of xs) {
    if (i.fromMs > cursor) consider(cursor, i.fromMs);
    cursor = Math.max(cursor, i.toMs);
  }
  if (cursor < toMs) consider(cursor, toMs);
  return best;
}

/** The card's check window for a show-night: [laneStart - 3h, embargo + 6h]. */
function checkWindow(times) {
  return { fromMs: times.laneStartMs - BEFORE_LANE_MIN * MIN, toMs: times.embargoMs + AFTER_EMBARGO_MIN * MIN };
}

module.exports = { collectorsFor, maxGap, checkWindow, ORCH_RUN_MIN, SWEEP_RUN_MIN, MAX_GAP_MIN, BEFORE_LANE_MIN, AFTER_EMBARGO_MIN };
