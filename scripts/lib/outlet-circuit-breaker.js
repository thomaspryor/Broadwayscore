'use strict';

/**
 * outlet-circuit-breaker.js — B2 of the v2 reconciler Sprint B plan
 * (~/Documents/claude-outputs/review-pipeline-from-scratch-design-2026-07-29.md):
 * "Extend classifyCell's state set … + Per-outlet circuit breaker."
 *
 * WHY THIS EXISTS
 * The v1 plan's "re-emit unresolved work every cycle until the diff closes /
 * only two terminal states" invariant re-introduces a bug this codebase already
 * fixed (REVISED PLAN v2, point 3): a permanently-blocked outlet — NYT/WSJ hard-
 * block the scrapers from CI IPs — would be re-dispatched forever and burn the
 * ScrapingBee quota. The existing guard against that is CI_UNFETCHABLE_OUTLETS
 * in review-census.js: a HARDCODED set of two ids. Hardcoding means a NEW hard
 * block (an outlet adds Cloudflare next month) gets no protection until a human
 * notices and edits the constant — which is exactly how NY Post / Hollywood
 * Reporter went silent for three months (task #582).
 *
 * This is the LEARNED half of the same idea: derive "retrieval is systemically
 * failing for this outlet" from the ledger's own evidence, trip a breaker, and
 * stop that outlet from driving dispatch — while keeping the cell VISIBLE so the
 * B1/B3 coverage scoreboard still counts it as missing. Visibility and
 * actionability are deliberately separate concerns:
 *   B1 exists to make outlet silence VISIBLE.
 *   B2 exists to stop RETRYING what can't succeed.
 * A tripped cell therefore behaves like SUPPRESSED (visible, blocks `complete`,
 * never dispatchable) rather than disappearing.
 *
 * EVIDENCE (deliberately not fetch-level)
 * There is no per-outlet fetch-outcome log in this pipeline — the closest thing,
 * t1-recovery-state.json (refetch-circuit-breaker.js), is keyed per FILE and
 * only covers the empty-body self-heal loop. So the evidence used here is the
 * ledger's own cross-show pattern, which the hourly job already computes and
 * commits:
 *   tripped ⟸ ≥ TRIP_MIN_GAP_CELLS distinct shows carry an open GAP for this
 *             outlet, ALL of them past TRIP_MIN_AGE_HOURS, AND the outlet has
 *             produced ZERO scored reviews on ANY in-window show.
 * The "zero recent successes" clause is what keeps this honest: an outlet with a
 * recent scored review demonstrably CAN be retrieved, so its individual gaps are
 * per-show problems (wrong URL, unscored file) and must stay dispatchable. Only
 * an outlet that is missing everywhere and landing nowhere trips.
 *
 * HALF-OPEN PROBE (why this is a breaker, not a blacklist)
 * An open breaker is never permanent: after PROBE_COOLDOWN_HOURS it goes
 * half-open, which is actionable again for a PROBE_WINDOW_HOURS window (not one
 * cycle — see that constant for why the distinction is load-bearing). A success
 * closes it and resets everything; a window that expires with no success re-opens
 * it with a DOUBLED cooldown, capped at MAX_PROBE_COOLDOWN_HOURS. So a fixed
 * outlet self-heals within a day, and a permanently dead one costs one probe per
 * week instead of one gather per hour.
 *
 * TWO SAFETY VALVES on top of that (both from an adversarial pre-ship review):
 *   MAX_NEW_TRIPS_PER_CYCLE — a mass trip means OUR pipeline broke, not theirs.
 *   T1_BREAKER_DISABLED=true — env kill switch, no deploy, no state surgery.
 *
 * Pure decision + pure state mutators, mirroring refetch-circuit-breaker.js;
 * the only fs touch is the load/save pair at the bottom. Single writer:
 * audit-opening-night-coverage.js --write-ledger (audit-aggregator-gap.yml).
 */

const fs = require('fs');
const path = require('path');

// A cell counts as evidence only once its show's clock is this old — inside the
// grace window a missing review is IN_FLIGHT, not a failure (t1-ledger.js).
// 72h (not 24h) because late-drop T1s (WSJ, Observer) routinely publish 24-36h
// after opening, so a 24h bar would trip on outlets that were merely slow.
const TRIP_MIN_AGE_HOURS = 72;

// How many DISTINCT shows must be gapped for the same outlet before it reads as
// systemic rather than per-show. 3 is the smallest count that can't be one
// bad roundup URL plus coincidence.
const TRIP_MIN_GAP_CELLS = 3;

// A scored review on a show whose clock is inside this window proves retrieval
// works for the outlet right now.
//
// This MUST be at least as wide as the window the gap observations come from, or
// the predicate is rigged: gaps accumulate over the caller's whole window while
// successes only count from a narrower slice, so any outlet with a summer lull
// trips. Live smoke-test against the real 90-day ledger with a 30-day success
// window tripped 14 outlets in one run (guardian, telegraph, FT, times-uk,
// vulture…) — every one of them a false positive that would have paused dispatch
// on healthy outlets. Callers pass successWindowHours = their own window (the
// audit ties it to --ledger-days); this default matches the audit's 90-day
// default so the two can't silently drift apart.
const SUCCESS_WINDOW_HOURS = 90 * 24;

const PROBE_COOLDOWN_HOURS = 24;
const MAX_PROBE_COOLDOWN_HOURS = 7 * 24;

// How long a half-open breaker STAYS half-open before it counts as a failed probe.
//
// This is not cosmetic. The breaker state advances on the HOURLY ledger job, but
// the thing that actually retries an outlet is the per-show gather dispatched by
// opening-night-reviews.yml, which runs on its own much slower schedule. A
// half-open window of "one ledger cycle" therefore expires before any probe can
// physically happen: the next hourly tick sees no success, calls it a failed
// probe, and re-opens with a doubled cooldown — so the breaker escalates all the
// way to the 7-day cap having never actually retried anything, and never
// self-heals. (Caught by an adversarial pre-ship review; the half-open design was
// otherwise decorative.) 12h comfortably spans the dispatch cadence.
const PROBE_WINDOW_HOURS = 12;

// If more than this many outlets would trip in ONE cycle, trip none of them.
// Rationale: the trip evidence is "no scored reviews for this outlet", which a
// pipeline-wide failure (scoring outage, rebuild stall, corpus read error)
// produces for EVERY outlet at once. A mass trip is therefore far better
// explained by "our own pipeline broke" than by "eleven outlets simultaneously
// started blocking us" — and silently pausing dispatch for everything is the
// worst possible response to that. Mirrors
// memory/feedback_conservative_default_can_be_common_case.
const MAX_NEW_TRIPS_PER_CYCLE = 3;

// Kill switch for the 2am case: an operator can neutralize the breaker without
// editing or deleting committed state, and without a deploy.
function breakerDisabled() {
  return String(process.env.T1_BREAKER_DISABLED || '').toLowerCase() === 'true';
}

const STATE_CLOSED = 'closed';
const STATE_OPEN = 'open';
const STATE_HALF_OPEN = 'half-open';

const ROOT = path.join(__dirname, '..', '..');
const BREAKER_PATH = path.join(ROOT, 'data', 'audit', 't1-outlet-breaker.json');

const DEFAULT_CONFIG = {
  tripMinAgeHours: TRIP_MIN_AGE_HOURS,
  tripMinGapCells: TRIP_MIN_GAP_CELLS,
  probeCooldownHours: PROBE_COOLDOWN_HOURS,
  maxProbeCooldownHours: MAX_PROBE_COOLDOWN_HOURS,
  probeWindowHours: PROBE_WINDOW_HOURS,
  maxNewTripsPerCycle: MAX_NEW_TRIPS_PER_CYCLE,
};

function emptyBreaker() {
  return { outlets: {} };
}

/** Normalize a stored per-outlet entry (missing/corrupt → closed). */
function entryOf(breaker, outletId) {
  const e = breaker && breaker.outlets && breaker.outlets[outletId];
  if (!e || typeof e !== 'object') return { state: STATE_CLOSED, probesUsed: 0 };
  return {
    state: e.state === STATE_OPEN || e.state === STATE_HALF_OPEN ? e.state : STATE_CLOSED,
    probesUsed: Number.isFinite(e.probesUsed) ? e.probesUsed : 0,
    openedAt: e.openedAt || null,
    nextProbeAt: e.nextProbeAt || null,
    probeUntil: e.probeUntil || null,
    lastSuccessAt: e.lastSuccessAt || null,
    gapCells: Number.isFinite(e.gapCells) ? e.gapCells : 0,
    reason: e.reason || null,
  };
}

/**
 * Is this outlet's breaker OPEN right now — i.e. must its cells be treated as
 * unactionable? half-open is deliberately NOT tripped: that IS the probe.
 *
 * Read-only and cheap, so the per-cell classification path can call it for
 * every cell without rolling state.
 */
function isOutletTripped(breaker, outletId) {
  if (breakerDisabled()) return false; // kill switch — nothing is ever suppressed
  return entryOf(breaker, outletId).state === STATE_OPEN;
}

/** The whole entry, for reporting/messaging (never mutated). */
function outletBreakerInfo(breaker, outletId) {
  return entryOf(breaker, outletId);
}

function hoursToMs(h) { return h * 3600000; }

/**
 * PURE decision for ONE outlet: given the prior entry and this cycle's evidence,
 * what is the next entry?
 *
 * @param {object} p
 * @param {object} p.prev       entryOf() result for this outlet
 * @param {object} p.evidence   { gapCells:number, minGapAgeHours:number|null, recentSuccess:boolean }
 *   gapCells        — distinct shows with an open (would-be-GAP) cell this cycle
 *   minGapAgeHours  — the YOUNGEST of those cells' show-clock ages (null if none);
 *                     requiring the youngest past the bar means ALL of them are
 *   recentSuccess   — outlet has ≥1 scored review on an in-window show
 * @param {number} p.nowMs
 * @param {object} [p.config]
 * @returns {{ entry: object, transition: string|null }}
 *   transition ∈ null | 'opened' | 'reopened' | 'half-open' | 'closed'
 */
function evaluateOutlet({ prev, evidence, nowMs, config = DEFAULT_CONFIG }) {
  const nowIso = new Date(nowMs).toISOString();
  const ev = evidence || {};
  const gapCells = Number.isFinite(ev.gapCells) ? ev.gapCells : 0;
  const minAge = Number.isFinite(ev.minGapAgeHours) ? ev.minGapAgeHours : null;
  const was = prev || { state: STATE_CLOSED, probesUsed: 0 };

  // A success always wins, from any state: retrieval demonstrably works, so the
  // breaker must close and forget its escalation history. Checked FIRST so a
  // half-open probe that landed can never be re-opened by the same cycle's
  // still-stale gap counts (a review scored minutes ago is still a GAP cell
  // until the next rebuild reflects it).
  if (ev.recentSuccess) {
    const entry = {
      state: STATE_CLOSED, probesUsed: 0, openedAt: null, nextProbeAt: null,
      probeUntil: null, lastSuccessAt: nowIso, gapCells, reason: null,
    };
    return { entry, transition: was.state === STATE_CLOSED ? null : 'closed' };
  }

  if (was.state === STATE_HALF_OPEN) {
    // The probe WINDOW must actually elapse before this counts as a failed
    // probe — see PROBE_WINDOW_HOURS. Re-opening on the very next hourly tick
    // would escalate the cooldown without any retry having been possible.
    const windowEndsMs = Date.parse(was.probeUntil);
    if (Number.isFinite(windowEndsMs) && nowMs < windowEndsMs) {
      return { entry: { ...was, gapCells }, transition: null }; // still probing
    }
    const probesUsed = (was.probesUsed || 0) + 1;
    const cooldown = Math.min(
      config.probeCooldownHours * Math.pow(2, probesUsed - 1),
      config.maxProbeCooldownHours,
    );
    return {
      entry: {
        state: STATE_OPEN, probesUsed,
        openedAt: was.openedAt || nowIso,
        nextProbeAt: new Date(nowMs + hoursToMs(cooldown)).toISOString(),
        probeUntil: null,
        lastSuccessAt: was.lastSuccessAt || null,
        gapCells, reason: 'systemic-retrieval-failure',
      },
      transition: 'reopened',
    };
  }

  if (was.state === STATE_OPEN) {
    const dueMs = Date.parse(was.nextProbeAt);
    if (Number.isFinite(dueMs) && nowMs >= dueMs) {
      return {
        entry: {
          ...was, state: STATE_HALF_OPEN, gapCells, reason: 'probe',
          probeUntil: new Date(nowMs + hoursToMs(config.probeWindowHours)).toISOString(),
        },
        transition: 'half-open',
      };
    }
    // Still cooling down. Refresh the observed gap count only.
    return { entry: { ...was, gapCells }, transition: null };
  }

  // Closed: trip only on the full evidence bar.
  const tripped = gapCells >= config.tripMinGapCells
    && minAge != null && minAge >= config.tripMinAgeHours;
  if (tripped) {
    return {
      entry: {
        state: STATE_OPEN, probesUsed: 0, openedAt: nowIso,
        nextProbeAt: new Date(nowMs + hoursToMs(config.probeCooldownHours)).toISOString(),
        probeUntil: null,
        lastSuccessAt: was.lastSuccessAt || null,
        gapCells, reason: 'systemic-retrieval-failure',
      },
      transition: 'opened',
    };
  }
  return { entry: { ...was, state: STATE_CLOSED, gapCells, reason: null }, transition: null };
}

/**
 * Advance the whole breaker by one cycle. Returns a NEW object (never mutates).
 *
 * Outlets absent from this cycle's evidence are carried forward UNCHANGED rather
 * than dropped or reset — the same discipline as outlet-heartbeat-state.js: a
 * partial corpus read (or a show simply ageing out of the ledger window) must
 * not silently close an open breaker and re-arm the dispatch storm.
 *
 * @param {object} prev  prior breaker object (or {})
 * @param {object} evidenceByOutlet { [outletId]: {gapCells, minGapAgeHours, recentSuccess} }
 * @param {number} nowMs
 * @param {object} [config]
 * @returns {{ breaker: object, transitions: Array<{outletId, transition, nextProbeAt}> }}
 */
function updateBreaker(prev, evidenceByOutlet, nowMs, config = DEFAULT_CONFIG) {
  const outlets = {};
  const transitions = [];
  const evidence = evidenceByOutlet || {};
  for (const outletId of Object.keys(evidence)) {
    const { entry, transition } = evaluateOutlet({
      prev: entryOf(prev, outletId), evidence: evidence[outletId], nowMs, config,
    });
    outlets[outletId] = entry;
    if (transition) transitions.push({ outletId, transition, nextProbeAt: entry.nextProbeAt || null });
  }

  // MASS-TRIP GUARD. A cycle that would newly trip more outlets than the cap is
  // evidence about US, not about them (see MAX_NEW_TRIPS_PER_CYCLE): the shared
  // cause is our own scoring/rebuild pipeline producing no scored reviews at all.
  // Suppress every NEW trip in that cycle and report it, rather than pausing
  // dispatch fleet-wide off one bad rebuild. Already-open breakers are untouched —
  // only fresh 'opened' transitions are rolled back.
  const opened = transitions.filter((t) => t.transition === 'opened');
  let massTripSuppressed = 0;
  if (opened.length > config.maxNewTripsPerCycle) {
    for (const t of opened) {
      // Restore the prior entry but keep this cycle's observed gap count, so the
      // evidence trail is intact and a genuine single-outlet trip still lands next
      // cycle once the pipeline recovers.
      outlets[t.outletId] = { ...entryOf(prev, t.outletId), gapCells: outlets[t.outletId].gapCells };
    }
    massTripSuppressed = opened.length;
  }
  const keptTransitions = massTripSuppressed
    ? transitions.filter((t) => t.transition !== 'opened')
    : transitions;

  for (const outletId of Object.keys((prev && prev.outlets) || {})) {
    if (!(outletId in outlets)) outlets[outletId] = entryOf(prev, outletId);
  }
  return { breaker: { outlets }, transitions: keptTransitions, massTripSuppressed };
}

/**
 * Aggregate per-outlet evidence out of the per-show cell computation.
 *
 * @param {Array<{outletId, showId, wouldBeGap:boolean, clockAgeHours:number|null}>} observations
 *   one row per (show, dispatch-tier outlet) the census expected and we lack
 * @param {Array<{outletId, clockAgeHours:number|null}>} successes
 *   one row per (show, outlet) that IS scored
 * @param {object} [opts] { successWindowHours }
 * @returns {object} evidenceByOutlet
 */
function buildEvidence(observations, successes, opts = {}) {
  const successWindow = opts.successWindowHours != null ? opts.successWindowHours : SUCCESS_WINDOW_HOURS;
  const out = {};
  // gapCells must be DISTINCT SHOWS, not raw observation count — the trip bar
  // ("≥3 different shows") is meaningless if one show can contribute 3 rows. That
  // holds incidentally today (unionCensus dedupes by outletId, so a show yields at
  // most one observation per outlet), but relying on a distant invariant is how the
  // "must match X" comment class of bug happens, so count showIds explicitly.
  const showsByOutlet = {};
  const touch = (outletId) => {
    if (!out[outletId]) {
      out[outletId] = { gapCells: 0, minGapAgeHours: null, recentSuccess: false };
      showsByOutlet[outletId] = new Set();
    }
    return out[outletId];
  };
  for (const o of observations || []) {
    if (!o || !o.outletId || !o.wouldBeGap) continue;
    const e = touch(o.outletId);
    // Fall back to a synthetic key when showId is absent so a caller that forgets
    // to pass it degrades to per-observation counting rather than collapsing every
    // observation into one bucket (which would make the breaker un-trippable).
    showsByOutlet[o.outletId].add(o.showId || `__anon:${showsByOutlet[o.outletId].size}`);
    e.gapCells = showsByOutlet[o.outletId].size;
    // A null clock means "unmeasurable" — it can never satisfy the age bar, so
    // record it as 0 (the youngest possible) rather than skipping it, or a
    // dateless show would silently lift the floor for the whole outlet.
    const age = Number.isFinite(o.clockAgeHours) ? o.clockAgeHours : 0;
    e.minGapAgeHours = e.minGapAgeHours == null ? age : Math.min(e.minGapAgeHours, age);
  }
  for (const s of successes || []) {
    if (!s || !s.outletId) continue;
    const age = Number.isFinite(s.clockAgeHours) ? s.clockAgeHours : null;
    if (age == null || age > successWindow) continue;
    touch(s.outletId).recentSuccess = true;
  }
  return out;
}

// --- thin I/O wrappers (the only fs touch) --------------------------------

function loadBreaker(breakerPath = BREAKER_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(breakerPath, 'utf8'));
    if (raw && typeof raw === 'object' && raw.outlets && typeof raw.outlets === 'object') return raw;
  } catch { /* missing / unparseable → fresh */ }
  return emptyBreaker();
}

/**
 * Write the breaker deterministically (sorted keys) so an unchanged cycle
 * produces byte-identical output and the hourly job's commit-on-change guard
 * doesn't churn a commit every hour.
 */
function serializeBreaker(breaker) {
  const outlets = {};
  for (const k of Object.keys((breaker && breaker.outlets) || {}).sort()) {
    const e = breaker.outlets[k];
    const sorted = {};
    for (const f of Object.keys(e).sort()) sorted[f] = e[f];
    outlets[k] = sorted;
  }
  return JSON.stringify({ outlets }, null, 2) + '\n';
}

function saveBreaker(breakerPath, breaker) {
  fs.mkdirSync(path.dirname(breakerPath), { recursive: true });
  const bytes = serializeBreaker(breaker);
  const before = fs.existsSync(breakerPath) ? fs.readFileSync(breakerPath, 'utf8') : '';
  if (before === bytes) return false;
  // ATOMIC write (tmp + rename). A truncated write is worse than no write here:
  // loadBreaker treats unparseable JSON as an empty/closed breaker, so a runner
  // killed mid-write would silently re-arm dispatch for every tripped outlet —
  // the exact storm the breaker exists to prevent, with no signal that it
  // happened. rename(2) is atomic within a filesystem, so a reader sees either
  // the old file or the new one.
  const tmp = `${breakerPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, breakerPath);
  return true;
}

module.exports = {
  isOutletTripped, outletBreakerInfo, evaluateOutlet, updateBreaker, buildEvidence,
  emptyBreaker, entryOf, loadBreaker, saveBreaker, serializeBreaker, breakerDisabled,
  BREAKER_PATH, DEFAULT_CONFIG,
  TRIP_MIN_AGE_HOURS, TRIP_MIN_GAP_CELLS, SUCCESS_WINDOW_HOURS,
  PROBE_COOLDOWN_HOURS, MAX_PROBE_COOLDOWN_HOURS, PROBE_WINDOW_HOURS,
  MAX_NEW_TRIPS_PER_CYCLE,
  STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN,
};
