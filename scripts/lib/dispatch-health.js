'use strict';

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
 * Fold + rate + digest-row live in ONE file rather than the two-file split
 * dispatch-outcome.js / dispatch-outcome-digest.js uses. Deliberate (raised in
 * the #1079 plan review): there is exactly one consumer shape here and the
 * fold is meaningless without the rate it feeds, whereas classifyDispatches()
 * has several independent callers. Split it if a second consumer ever needs
 * the attempts without the rate.
 *
 * ── How a dead attempt appears in the ledger ──────────────────────────────
 * Each `launch` row is one dispatch ATTEMPT — the denominator. There are THREE
 * end states, and none of them is simply "count the `dead` rows":
 *
 *  1. CONFIRMED DEAD, injection never ran. dispatch-ledger's
 *     failedLaunchEntries() writes a `dead` row IMMEDIATELY followed by a
 *     `launch` row with `unverified: true` for the SAME attempt (observed
 *     1-2ms apart). The attempt is already present exactly once as a launch
 *     that self-identifies as dead — counting the `dead` row too would
 *     double-count it.
 *  2. CONFIRMED DEAD, discovered later. bsc-prune's deadBreadcrumbs: the
 *     launch was a normal, verified `launch` row, and a `dead` row is appended
 *     minutes-to-hours later when the sweep finds the workspace idle and
 *     never-booted. That death must be attributed BACK to the earlier launch.
 *  3. UNVERIFIED. failedLaunchEntries({deadConfirmed:false}) — the #705
 *     slow-boot case: verification gave up while the wrapper process was STILL
 *     RUNNING, so the ledger deliberately writes NO `dead` row ("recording a
 *     dead breadcrumb for it would be a lie with teeth"). The launch is
 *     unverified with no pair. On the real ledger 7 of 53 unverified launches
 *     are this shape. They are NOT counted as deaths (that would inflate the
 *     rate with sessions that very likely booted fine) and NOT counted as
 *     healthy either — they get their own bucket and their own line in the
 *     digest message, because silently calling an unknown outcome "healthy" is
 *     the vacuous-gate class this repo keeps paying for (#1063/#1069/#1075).
 *
 * On the real ledger as of 2026-08-10: 452 launch rows, 53 unverified, 67
 * `dead` rows — 46 shape-1 pairs, 21 shape-2 breadcrumbs, 7 shape-3.
 *
 * workspaceRef pairing is LAST-MATCH-AT-OR-BEFORE, never first-match: cmux
 * recycles refs (144 of 452 launch rows reuse one — workspace:247 was launched
 * 2026-07-23 and again 2026-08-01), and first-match would hang a fresh death
 * on a month-old attempt. Same rule dispatch-ledger.js's launchByRef already
 * follows for card #960.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// A shape-1 `dead` row and its unverified `launch` row are two separate
// appendLedgerEntry() calls, observed 1-2ms apart. Generous slack (a
// concurrent writer can interleave rows between them) but far below the
// minutes-to-hours lag of a shape-2 breadcrumb, which must NOT be mistaken
// for a pair.
const PAIR_WINDOW_MS = 5000;

// The lane this card is about: cmux tabs, where the terminal surface fails to
// render. `headless:` launches are the job lane — a different failure
// mechanism entirely (PID/lease, reconciled by bsc-reconcile.js), so folding
// them into the paging rate would dilute exactly the signal being measured.
// They stay visible in byLane.
const CMUX_LANE = 'workspace';

// Any workspaceRef without a "prefix:" shape (the real ledger has
// "live-session-manual"). Bucketed rather than dropped so byLane always
// accounts for every launch.
const OTHER_LANE = 'other';

// windowDays=7 because the card's own evidence is a 7-day span and a single
// day is far too small to read a ~20% rate off (2026-08-07 and 08-08 had 4
// launches each). deadRateFloor=0.10 per the card. minLaunches=20 keeps a
// quiet stretch from paging on 1-of-3.
const DEFAULTS = { windowDays: 7, deadRateFloor: 0.10, minLaunches: 20 };

const CHECK_NAME = 'Dispatch health: dead-launch rate';

const HINT = 'Each dead launch = a cmux workspace whose terminal surface never rendered, so the injected command never fired. '
  + 'Run `node scripts/audit-dispatch-dead-rate.js` for the per-day/per-lane breakdown and the affected task ids. '
  + 'Judge any fix by this rate over a week, never by one clean test dispatch — a 1-in-5 intermittent failure passes almost any single verification (card #1199).';

function laneOf(workspaceRef) {
  const ref = String(workspaceRef || '');
  const i = ref.indexOf(':');
  return i > 0 ? ref.slice(0, i) : OTHER_LANE;
}

function tsOf(entry) {
  const t = Date.parse(entry && entry.ts);
  return Number.isFinite(t) ? t : null;
}

/**
 * Fold ledger rows into one record per dispatch ATTEMPT, each classified dead
 * / unverified / alive. See the header for the three shapes.
 *
 * @param {object[]} entries raw dispatch-ledger.jsonl rows
 * @returns {{attempts: Array<{ts:number, tsIso:string, taskId:string|null,
 *            workspaceRef:string|null, lane:string, model:string|null,
 *            dead:boolean, unverified:boolean, deadReason:string|null}>,
 *           unattributedDeadCount:number}}
 *   unattributedDeadCount = `dead` rows whose launch is not in `entries` at
 *   all (rotated/truncated ledger). Surfaced rather than silently dropped OR
 *   folded into the rate — either would be a lie about the denominator.
 */
function foldAttempts(entries) {
  // Sort by ts with an index tiebreak so out-of-order appends from concurrent
  // writers can't reorder a shape-1 pair relative to an unrelated attempt.
  // Rows with no parseable ts are dropped — they can't be windowed, and a
  // launch that can't be dated can't honestly join a rate.
  const rows = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && typeof e === 'object' && tsOf(e) !== null)
    .map((e, i) => ({ e, i, t: tsOf(e) }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.e);

  const attempts = [];
  const idxByRef = new Map(); // workspaceRef -> attempt indices, in ts order

  for (const e of rows) {
    if (e.event !== 'launch') continue;
    const ref = e.workspaceRef || null;
    const isUnverified = e.unverified === true;
    const idx = attempts.push({
      ts: tsOf(e),
      tsIso: e.ts,
      taskId: e.taskId != null ? String(e.taskId) : null,
      workspaceRef: ref,
      lane: laneOf(ref),
      model: e.model || null,
      // Promoted to `dead` below iff a `dead` row claims this attempt. An
      // unverified launch with no such row is shape 3 and stays unverified.
      dead: false,
      unverified: isUnverified,
      deadReason: null,
    }) - 1;
    if (ref) {
      if (!idxByRef.has(ref)) idxByRef.set(ref, []);
      idxByRef.get(ref).push(idx);
    }
  }

  let unattributedDeadCount = 0;

  for (const e of rows) {
    if (e.event !== 'dead') continue;
    const ref = e.workspaceRef || null;
    const deadTs = tsOf(e);
    const candidates = ref ? (idxByRef.get(ref) || []) : [];
    if (candidates.length === 0) { unattributedDeadCount++; continue; }

    // Shape 1 — this death's OWN unverified launch, written ~1ms LATER (so a
    // plain ts<=deadTs search would skip past it onto an older, unrelated
    // attempt on the recycled ref). Claim the nearest unclaimed unverified
    // attempt inside the pair window.
    const pairIdx = candidates.find((i) => attempts[i].unverified
      && !attempts[i].dead
      && Math.abs(attempts[i].ts - deadTs) <= PAIR_WINDOW_MS);
    if (pairIdx !== undefined) {
      attempts[pairIdx].dead = true;
      attempts[pairIdx].deadReason = e.failureReason || 'launch never verified';
      continue;
    }

    // Shape 2 — a breadcrumb for an earlier, verified launch. Last match at
    // or before the death (card #960: never first-match on a recycled ref).
    let target;
    for (let k = candidates.length - 1; k >= 0; k--) {
      if (attempts[candidates[k]].ts <= deadTs) { target = candidates[k]; break; }
    }
    if (target === undefined) { unattributedDeadCount++; continue; }
    if (!attempts[target].dead) {
      attempts[target].dead = true;
      attempts[target].deadReason = e.failureReason || 'workspace found dead by sweep';
    }
  }

  // `remapped` (ship-check finding): after a cmux restart, dispatch-ledger
  // rewrites a live dispatch onto a NEW ref and journals
  // {event:'remapped', workspaceRef:<old>, newRef:<new>}. The same real
  // dispatch therefore owns two launch rows — and the old one is typically
  // unverified:true, because verification is what gave up when cmux
  // restarted. Counting both inflates the denominator AND manufactures a
  // phantom "unverified" attempt out of a dispatch that in fact continued
  // fine. Only 3 remaps exist in the ledger today, but the error is silent
  // and grows with any restart storm. dispatch-ledger.js already treats
  // 'remapped' as terminal for the old ref (TERMINAL_LAUNCH_EVENTS) — this
  // applies the same rule to the rate.
  const superseded = new Set();
  for (const e of rows) {
    if (e.event !== 'remapped' || !e.workspaceRef) continue;
    const remapTs = tsOf(e);
    const candidates = idxByRef.get(e.workspaceRef) || [];
    for (let k = candidates.length - 1; k >= 0; k--) {
      const idx = candidates[k];
      if (attempts[idx].ts > remapTs) continue;
      // A CONFIRMED-DEAD attempt is never superseded (adversarial review of
      // the first cut of this fix, which had exactly this bug). The restart
      // sweep in dispatch-ledger.js remaps a ref regardless of whether its
      // occupant already died, so on the real ledger task #925's only launch
      // — workspace:99, paired `dead` row 1ms later, "command injection never
      // ran" — was erased by a remap NINE HOURS later, removing a real death
      // from both `dead` and `deadTaskIds`. Superseding is for "this dispatch
      // continued under a new ref", which a corpse by definition did not do.
      if (!attempts[idx].dead) superseded.add(idx);
      break;
    }
  }

  return {
    attempts: attempts.filter((_, i) => !superseded.has(i)),
    unattributedDeadCount,
    // The attempts themselves, not a bare count: computeDeadRate scopes them
    // to its window like every other figure on the row. A lifetime total on a
    // windowed row silently stops reconciling as remaps accumulate (same
    // review).
    supersededAttempts: [...superseded].map((i) => attempts[i]),
  };
}

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
