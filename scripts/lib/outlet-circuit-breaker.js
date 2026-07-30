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
 * half-open, which is actionable again for one cycle. A success closes it and
 * resets everything; a failed probe re-opens it with a DOUBLED cooldown, capped
 * at MAX_PROBE_COOLDOWN_HOURS. So a fixed outlet self-heals within a day, and a
 * permanently dead one costs one probe per week instead of one gather per hour.
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
      lastSuccessAt: nowIso, gapCells, reason: null,
    };
    return { entry, transition: was.state === STATE_CLOSED ? null : 'closed' };
  }

  if (was.state === STATE_HALF_OPEN) {
    // The probe cycle ran and produced no success → re-open with a doubled
    // cooldown (capped). probesUsed is the escalation exponent.
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
        entry: { ...was, state: STATE_HALF_OPEN, gapCells, reason: 'probe' },
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
  for (const outletId of Object.keys((prev && prev.outlets) || {})) {
    if (!(outletId in outlets)) outlets[outletId] = entryOf(prev, outletId);
  }
  return { breaker: { outlets }, transitions };
}

/**
 * Aggregate per-outlet evidence out of the per-show cell computation.
 *
 * @param {Array<{outletId, wouldBeGap:boolean, clockAgeHours:number|null}>} observations
 *   one row per (show, dispatch-tier outlet) the census expected and we lack
 * @param {Array<{outletId, clockAgeHours:number|null}>} successes
 *   one row per (show, outlet) that IS scored
 * @param {object} [opts] { successWindowHours }
 * @returns {object} evidenceByOutlet
 */
function buildEvidence(observations, successes, opts = {}) {
  const successWindow = opts.successWindowHours != null ? opts.successWindowHours : SUCCESS_WINDOW_HOURS;
  const out = {};
  const touch = (outletId) => (out[outletId] = out[outletId]
    || { gapCells: 0, minGapAgeHours: null, recentSuccess: false });
  for (const o of observations || []) {
    if (!o || !o.outletId || !o.wouldBeGap) continue;
    const e = touch(o.outletId);
    e.gapCells++;
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
  fs.writeFileSync(breakerPath, bytes);
  return true;
}

module.exports = {
  isOutletTripped, outletBreakerInfo, evaluateOutlet, updateBreaker, buildEvidence,
  emptyBreaker, entryOf, loadBreaker, saveBreaker, serializeBreaker,
  BREAKER_PATH, DEFAULT_CONFIG,
  TRIP_MIN_AGE_HOURS, TRIP_MIN_GAP_CELLS, SUCCESS_WINDOW_HOURS,
  PROBE_COOLDOWN_HOURS, MAX_PROBE_COOLDOWN_HOURS,
  STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN,
};
