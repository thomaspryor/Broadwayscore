'use strict';

const { foldAttempts, CMUX_LANE, OTHER_LANE, PAIR_WINDOW_MS, DAY_MS } = require('./dispatch-attempts.js');

/**
 * dispatch-health — the dead-dispatch RATE over a window.
 *
 * Card #1199. Roughly one bsc-next launch in five never runs the work it
 * seeded: the cmux workspace is created, its terminal surface never renders,
 * the injected command never fires, and the attempt is journaled dead in
 * data/audit/dispatch-ledger.jsonl. The retry layer (watchdog-redispatch,
 * bsc-prune breadcrumbs, the #1144 completion guard) recovers the WORK — no
 * task was actually lost — so every individual session sees only its own 1-3
 * failures, retries, succeeds, and truthfully reports success. Nothing ever
 * aggregated the ledger, so a chronic ~20% failure rate ran for a week
 * completely unseen.
 *
 * That invisibility is also why several previous "fixes" looked like they
 * worked: a 1-in-5 intermittent failure passes almost any single post-fix
 * verification. This module exists so a fix is judged by the rate across many
 * launches instead of by one clean dispatch.
 *
 * Pure — no I/O, no clock (CLAUDE.md rule 15: callers read the ledger and pass
 * `nowMs`; the required test require()s this directly rather than copying the
 * counting logic).
 *
 * The attempt-folding logic (foldAttempts and its shape-1/shape-2/shape-3
 * classification of a dead launch) moved to dispatch-attempts.js as of card
 * #1233 — dispatch-ledger.js's dead-attempt dispatch cap needed the same
 * per-attempt INFRA-vs-SUBSTANTIVE classification this module already
 * computed, which is exactly the "second consumer needs the attempts without
 * the rate" trigger this file's header used to name as the cue to split. See
 * dispatch-attempts.js's header for the full shape-1/2/3 explanation; this
 * file re-exports foldAttempts/PAIR_WINDOW_MS/etc. unchanged so no existing
 * caller here needed to change.
 */

// windowDays=7 because the card's own evidence is a 7-day span and a single
// day is far too small to read a ~20% rate off (2026-08-07 and 08-08 had 4
// launches each). deadRateFloor=0.10 per the card. minLaunches=20 keeps a
// quiet stretch from paging on 1-of-3.
const DEFAULTS = { windowDays: 7, deadRateFloor: 0.10, minLaunches: 20 };

const CHECK_NAME = 'Dispatch health: dead-launch rate';

const HINT = 'Each dead launch = a cmux workspace whose terminal surface never rendered, so the injected command never fired. '
  + 'Run `node scripts/audit-dispatch-dead-rate.js` for the per-day/per-lane breakdown and the affected task ids. '
  + 'Judge any fix by this rate over a week, never by one clean test dispatch — a 1-in-5 intermittent failure passes almost any single verification (card #1199).';

/**
 * Dead/launch counts over a trailing window, for ONE lane.
 *
 * @param {object[]} entries raw dispatch-ledger.jsonl rows
 * @param {object} opts
 * @param {number} opts.nowMs REQUIRED window anchor (epoch ms). No default: a
 *   lib that silently reaches for Date.now() can't be tested deterministically.
 * @param {number} [opts.windowDays=7]
 * @param {string} [opts.lane='workspace'] lane the headline rate covers.
 *   byLane always reports every lane regardless.
 * @returns {{lane:string, windowDays:number, windowStartIso:string,
 *            launches:number, dead:number, deadRate:number, unverified:number,
 *            byLane:Object<string,{launches:number,dead:number,unverified:number}>,
 *            deadTaskIds:string[], unverifiedTaskIds:string[],
 *            unattributedDeadCount:number,
 *            perDay:Array<{day:string, launches:number, dead:number}>}}
 */
function computeDeadRate(entries, { nowMs, windowDays = DEFAULTS.windowDays, lane = CMUX_LANE } = {}) {
  if (!Number.isFinite(nowMs)) {
    throw new Error('dispatch-health.computeDeadRate: nowMs (epoch ms) is required — this module takes no clock of its own');
  }
  const windowStart = nowMs - windowDays * DAY_MS;
  const { attempts, unattributedDeadCount, supersededAttempts } = foldAttempts(entries);
  const inWindow = attempts.filter((a) => a.ts >= windowStart && a.ts <= nowMs);
  const supersededByRemapCount = supersededAttempts
    .filter((a) => a.ts >= windowStart && a.ts <= nowMs && a.lane === lane).length;

  const byLane = {};
  for (const a of inWindow) {
    const bucket = (byLane[a.lane] ||= { launches: 0, dead: 0, unverified: 0 });
    bucket.launches++;
    if (a.dead) bucket.dead++;
    // Shape 3 only: a claimed pair is a death, not an open question.
    if (a.unverified && !a.dead) bucket.unverified++;
  }

  const scoped = inWindow.filter((a) => a.lane === lane);
  const perDayMap = new Map();
  for (const a of scoped) {
    const day = a.tsIso.slice(0, 10);
    const d = perDayMap.get(day) || { day, launches: 0, dead: 0 };
    d.launches++;
    if (a.dead) d.dead++;
    perDayMap.set(day, d);
  }

  const launches = scoped.length;
  const deadAttempts = scoped.filter((a) => a.dead);
  const unverifiedAttempts = scoped.filter((a) => a.unverified && !a.dead);

  return {
    lane,
    windowDays,
    windowStartIso: new Date(windowStart).toISOString(),
    launches,
    dead: deadAttempts.length,
    deadRate: launches === 0 ? 0 : deadAttempts.length / launches,
    unverified: unverifiedAttempts.length,
    byLane,
    // The re-dispatch worklist, and what to eyeball for clustering: many
    // deaths on one task = the retry guard burning attempts; many distinct
    // tasks inside one minute = the burst-creation theory the card raises.
    deadTaskIds: [...new Set(deadAttempts.filter((a) => a.taskId).map((a) => a.taskId))],
    unverifiedTaskIds: [...new Set(unverifiedAttempts.filter((a) => a.taskId).map((a) => a.taskId))],
    unattributedDeadCount,
    supersededByRemapCount,
    perDay: [...perDayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}

/**
 * The daily-digest row. Pages ('error') when the dead rate is above the floor
 * on a large enough sample.
 *
 * Deliberately NOT change-suppressed the way computeDispatchOutcomeDigest is
 * (which returns null when abandonedCount === previousAbandonedCount). A
 * static COUNT is stale news; a RATE above the floor is a live, ongoing defect
 * every day it holds, and suppressing "same as yesterday" is precisely the
 * invisibility this card exists to end. Repeat-day email noise is already
 * handled a layer up: health-check.js routes actionable rows through
 * owner-alert-router's `conditionKey` (health-check.js:3278-3288), which files
 * one card per OPEN incident rather than one per run.
 */
function computeDispatchHealthDigest({
  entries,
  nowMs,
  windowDays = DEFAULTS.windowDays,
  deadRateFloor = DEFAULTS.deadRateFloor,
  minLaunches = DEFAULTS.minLaunches,
  lane = CMUX_LANE,
} = {}) {
  const stats = computeDeadRate(entries, { nowMs, windowDays, lane });
  const pct = (stats.deadRate * 100).toFixed(0);
  const floorPct = (deadRateFloor * 100).toFixed(0);
  const span = `last ${windowDays}d`;
  const detail = `${stats.dead}/${stats.launches} ${lane} launches never ran (${span})`;
  const unverifiedNote = stats.unverified > 0
    ? ` ${stats.unverified} further launch(es) were left unverified (outcome unknown, not counted either way).`
    : '';

  // Zero launches is NOT a pass — there is nothing to measure, and calling an
  // empty denominator "healthy" is the vacuous-gate class (#1063/#1069/#1075).
  if (stats.launches === 0) {
    return {
      name: CHECK_NAME,
      status: 'warn',
      message: `No ${lane} dispatch launches in the ${span} — the dead-launch rate cannot be measured from this ledger.`,
      hint: 'data/audit/dispatch-ledger.jsonl is per-machine and gitignored; run this where dispatches actually launch.',
      ...stats,
    };
  }

  if (stats.deadRate <= deadRateFloor) {
    return {
      name: CHECK_NAME,
      status: 'pass',
      message: `Dead-launch rate ${pct}% — ${detail}, at or under the ${floorPct}% floor.${unverifiedNote}`,
      ...stats,
    };
  }

  // Over the floor but too few launches to tell a real regression from one
  // unlucky pair. Still visible (warn), never a silent pass.
  if (stats.launches < minLaunches) {
    return {
      name: CHECK_NAME,
      status: 'warn',
      message: `Dead-launch rate ${pct}% (${detail}) is over the ${floorPct}% floor, but only ${stats.launches} launches — below the ${minLaunches}-launch minimum to call it.${unverifiedNote}`,
      hint: HINT,
      ...stats,
    };
  }

  const laneSummary = Object.entries(stats.byLane)
    .map(([name, v]) => `${name} ${v.dead}/${v.launches}`)
    .join(', ');

  return {
    name: CHECK_NAME,
    status: 'error',
    message: `Dead-launch rate ${pct}% is over the ${floorPct}% floor — ${detail}. By lane: ${laneSummary}. ${stats.deadTaskIds.length} task(s) affected.${unverifiedNote}`,
    hint: HINT,
    ...stats,
  };
}

module.exports = {
  foldAttempts,
  computeDeadRate,
  computeDispatchHealthDigest,
  CHECK_NAME,
  CMUX_LANE,
  OTHER_LANE,
  DEFAULTS,
  PAIR_WINDOW_MS,
};
