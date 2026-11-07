'use strict';

/**
 * lane-trouble-rate.js — per-lane "trouble" rate for dispatch launches (BRO-2978).
 *
 * audit-headless-outcome-rate.js and audit-dispatch-dead-rate.js only read how a
 * task ENDED, so a task that was orphaned and retried before succeeding scores
 * 'done' and its wasted retries are invisible. This measures that: the share of
 * launches (and of tasks) in each lane that hit at least one trouble event.
 *
 * Lanes are never mixed (BRO-2959's "cmux 36% / headless 32%" counted the same
 * 9 orphan tasks in both columns, since each has a cmux `launch` row AND a
 * headless `job-spawned` row). A launch belongs to the lane of its own
 * workspaceRef, and only that lane's trouble events count for it:
 *   - headless: job-orphaned, job-retried, job-failed (taskId events inside the
 *     launch's ownership window, i.e. up to the task's next launch)
 *   - cmux (and any other tab lane): dead, launch-failed rows on the same
 *     workspaceRef inside that launch's window
 * Pure: takes entries + nowMs, no clock, no I/O (CLAUDE.md rule 15).
 */

const { laneOf, tsOf, DAY_MS, PAIR_WINDOW_MS } = require('./dispatch-attempts.js');
const { JOB_EVENTS } = require('./dispatch-ledger.js');
const { JOB_LANE } = require('./dispatch-health.js');

const HEADLESS_TROUBLE = new Set([JOB_EVENTS.ORPHANED, JOB_EVENTS.RETRIED, JOB_EVENTS.FAILED]);
const TAB_TROUBLE = new Set(['dead', 'launch-failed']);

function computeLaneTroubleRate(entries, { nowMs, windowDays = 7 } = {}) {
  if (!Number.isFinite(nowMs)) {
    throw new Error('lane-trouble-rate.computeLaneTroubleRate: nowMs (epoch ms) is required');
  }
  const rows = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ e, ts: tsOf(e) })).filter((r) => r.ts !== null);
  const windowStart = nowMs - windowDays * DAY_MS;

  // launches grouped by (lane, taskId), time-ordered, so a window ends at the next launch of the same task in the same lane
  const groups = new Map();
  for (const r of rows) {
    if (r.e.event !== 'launch' || r.e.taskId == null) continue;
    const key = `${laneOf(r.e.workspaceRef)}\u0000${String(r.e.taskId)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const lanes = {};
  for (const [key, launches] of groups) {
    const [lane, taskId] = key.split('\u0000');
    launches.sort((a, b) => a.ts - b.ts);
    const troubleSet = lane === JOB_LANE ? HEADLESS_TROUBLE : TAB_TROUBLE;
    const laneStats = () => lanes[lane] || (lanes[lane] = {
      launches: 0, troubledLaunches: 0, tasks: 0, troubledTasks: 0, events: {},
    });
    let taskTroubled = false;
    let taskCounted = false;
    for (let i = 0; i < launches.length; i++) {
      const launch = launches[i];
      if (launch.ts < windowStart || launch.ts > nowMs) continue;
      const upper = i + 1 < launches.length ? launches[i + 1].ts : Infinity;
      const hits = rows.filter((r) => troubleSet.has(r.e.event)
        && String(r.e.taskId) === taskId
        // a failed tab launch writes its `dead` row just BEFORE its `launch` row
        // (failedLaunchEntries), so the lower bound reaches back PAIR_WINDOW_MS;
        // `launch-failed` rows carry no workspaceRef, so they match on taskId alone
        && (lane === JOB_LANE || !r.e.workspaceRef || r.e.workspaceRef === launch.e.workspaceRef)
        && r.ts >= launch.ts - (lane === JOB_LANE ? 0 : PAIR_WINDOW_MS) && r.ts < upper);
      const L = laneStats();
      L.launches++;
      taskCounted = true;
      if (hits.length) {
        L.troubledLaunches++;
        taskTroubled = true;
        for (const h of hits) L.events[h.e.event] = (L.events[h.e.event] || 0) + 1;
      }
    }
    if (taskCounted) { const L = laneStats(); L.tasks++; if (taskTroubled) L.troubledTasks++; }
  }

  for (const L of Object.values(lanes)) {
    L.troubledLaunchRate = L.launches ? L.troubledLaunches / L.launches : 0;
    L.troubledTaskRate = L.tasks ? L.troubledTasks / L.tasks : 0;
  }
  return { windowDays, windowStartIso: new Date(windowStart).toISOString(), lanes };
}

module.exports = { computeLaneTroubleRate, HEADLESS_TROUBLE, TAB_TROUBLE };
