'use strict';

/**
 * dispatch-attempts — pure fold of dispatch-ledger.jsonl rows into one record
 * per dispatch ATTEMPT, each classified dead / unverified / alive.
 *
 * Extracted from dispatch-health.js (card #1233) the moment a second
 * consumer needed the attempts themselves rather than the dead-rate digest
 * built on top of them — exactly the split dispatch-health.js's own header
 * comment called for ("Split it if a second consumer ever needs the
 * attempts without the rate"). dispatch-ledger.js's dead-attempt cap
 * (classifyDeadAttemptsForTask) is that second consumer: it needs to know
 * INFRA vs SUBSTANTIVE per attempt, not a windowed rate. Both
 * dispatch-health.js and dispatch-ledger.js require this leaf module; this
 * module requires neither of them, and never will — it exists specifically
 * so dispatch-ledger.js (25 requirers, the foundational ledger) never has to
 * reach up into its own narrower digest consumer to get this.
 *
 * Zero I/O, zero dependencies — same "leaf util" shape as this file's own
 * existing predicates (isLatestDispatchDead, detectLauncherOutage,
 * looksLikeRestart in dispatch-ledger.js) which take nothing but fs/path.
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
 *     healthy either — they get their own bucket, because silently calling an
 *     unknown outcome "healthy" is the vacuous-gate class this repo keeps
 *     paying for (#1063/#1069/#1075).
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

// Events that END a launch's life, so a LATER `dead` row on the same ref
// belongs to whatever cmux handed the recycled ref to next, not to this
// attempt (task #1904). Mirrors dispatch-ledger.js's TERMINAL_LAUNCH_EVENTS
// minus 'dead' itself — duplicated rather than imported on purpose: this is
// the leaf module dispatch-ledger.js requires, and reaching back up into it
// would be the import cycle this file's header promises never to create.
// dispatch-ledger.js's own deadBreadcrumbs now refuses to WRITE these rows;
// this is the reader side, because eleven of them are already in the ledger
// and would otherwise keep inflating the dead rate for another week.
const RECONCILING_EVENTS = new Set(['vanished', 'prune-closed', 'remapped']);

// The one `dead` writer the reconciling rule must NOT disown (/code-review
// finding 6, decided deliberately 2026-08-26 — this module feeds the very
// metric card #1904 is judged on, so quietly deflating it would be the worst
// possible place to be wrong).
//
// Enumerated every writer of a `dead` row before deciding:
//  1. dispatch-ledger.js failedLaunchEntries — shape 1, resolved by the pair
//     window ABOVE this rule, so already immune.
//  2. dispatch-ledger.js deadBreadcrumbs — only ever journals refs cmux STILL
//     LISTS, so a vanished/prune-closed row on that ref necessarily means cmux
//     recycled it and the death belongs to the next occupant. Its writer-side
//     guard now refuses to emit new ones at all.
//  3. bsc-prune.js's no-payload reaper — CLOSES the workspace itself and then
//     writes {event:'dead', reason:'no-payload'}. This is the only writer that
//     can legitimately produce a real death sitting behind a reconciling row
//     on its own ref, so it is the only one exempted.
//
// Measured on the real ledger (8,822 rows) at decision time: 18 dead rows are
// currently excluded by the reconciling rule — 13 targeting a verified launch,
// 5 an unverified one — and their launch→death gaps run from 9 hours to 31
// DAYS, i.e. every one is a recycled ref. Two candidate discriminators were
// rejected on that data: excluding only `unverified` attempts, and requiring
// the reconciling row to postdate the launch by more than the verify budget.
// Both would have re-attributed multi-week-stale recycled-ref deaths to
// long-finished tasks, INFLATING the rate with false deaths — the opposite of
// the failure they were meant to prevent. All 5 no-payload rows in the ledger
// today are already attributed, so this exemption changes no current number;
// it is purely a guard against the one shape that could go wrong.
const SELF_CLOSING_DEAD_REASONS = new Set(['no-payload']);

// Any workspaceRef without a "prefix:" shape (the real ledger has
// "live-session-manual"). Bucketed rather than dropped so byLane always
// accounts for every launch.
const OTHER_LANE = 'other';

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

  // ts-ordered reconciling events per ref, for the shape-2 recycling check.
  const reconciledByRef = new Map();
  for (const e of rows) {
    if (!RECONCILING_EVENTS.has(e.event) || !e.workspaceRef) continue;
    if (!reconciledByRef.has(e.workspaceRef)) reconciledByRef.set(e.workspaceRef, []);
    reconciledByRef.get(e.workspaceRef).push(tsOf(e));
  }

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
    // …unless that attempt was already RECONCILED before the death (task
    // #1904). cmux recycles refs, so a sweep that finds workspace:46 idle
    // long after #1888 finished and was prune-closed writes a `dead` row
    // naming #1888 on a tab #1888 no longer owns. Live on 2026-08-26: #1887
    // and #1888 both completed at 05:03Z/05:16Z and were journaled dead at
    // 13:19:55Z; 11 such rows since 08-19, 2 of them inside the 7-day rate
    // window this module feeds. The death is real for SOMEBODY — it just
    // isn't this attempt's, and there is no launch row for the current
    // occupant — so it joins unattributedDeadCount (surfaced, never folded
    // into the rate) rather than being silently dropped.
    // …with ONE exemption: a writer that closed the workspace ITSELF and then
    // journaled the death owns that death outright, whatever reconciling row
    // its own close left on the ref. See SELF_CLOSING_DEAD_REASONS.
    const selfClosed = SELF_CLOSING_DEAD_REASONS.has(e.reason);
    const reconciledTs = !selfClosed && (reconciledByRef.get(ref) || [])
      .some((t) => t !== null && t >= attempts[target].ts && t <= deadTs);
    if (reconciledTs) { unattributedDeadCount++; continue; }
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
    // The attempts themselves, not a bare count: callers that scope figures
    // to a window (dispatch-health.js's computeDeadRate) need the objects,
    // not a lifetime total that silently stops reconciling as remaps
    // accumulate (same review that found the bug above).
    supersededAttempts: [...superseded].map((i) => attempts[i]),
  };
}

module.exports = {
  foldAttempts,
  laneOf,
  tsOf,
  CMUX_LANE,
  OTHER_LANE,
  PAIR_WINDOW_MS,
  DAY_MS,
};
