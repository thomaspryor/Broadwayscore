'use strict';

/**
 * t1-ledger.js — pure state machine + merge for the T1 coverage ledger
 * (data/audit/t1-coverage-ledger.json). SINGLE WRITER: audit-aggregator-gap.yml
 * only; commit-on-change (serialize is deterministic so unchanged data → byte-
 * identical output → no commit). See sprint-plan-t1-retrieval.md S2-T3.
 *
 * A cell is one (showId, outletId) the census expects but we do not have scored.
 * States:
 *   IN_FLIGHT          — missing, but the clock (max(openingDate, showCreatedAt),
 *                        refined by publishDate provenance in S2-T6) is <24h old:
 *                        reviews are still legitimately arriving.
 *   GAP                — missing ≥24h. Carries firstSeenAt (when we first logged
 *                        the gap) so age is derivable; the SLA burn-down list.
 *   NO_REVIEW_EXPECTED — registry evidence says the outlet does not review this
 *                        market (coverageExpectation:'none' / reviewsTheater:false).
 *   SUPPRESSED         — censused but unfetchable from CI (WSJ / New Yorker): stays
 *                        visible, never dispatchable, never counted as an SLA miss.
 * Present-and-scored cells are NOT recorded (absence = covered).
 */

const GRACE_HOURS = 24;

/**
 * Tier gate for dispatch/severity/ledger decisions: only registered T1/T2
 * outlets count. Registry tiers are always numeric (1–4); an unregistered or
 * phantom outletId (undefined tier) is excluded, so census junk (e.g.
 * "buy-tickets-directly-from-the-theatre") can't drive dispatch or SLA cells.
 * Full censusMissing stays informational in the audit output — this predicate
 * scopes only what ACTS (dispatch triggers, major severity, ledger cells).
 * @param {object} outlets  outlet-registry map
 * @param {string} outletId
 * @returns {boolean}
 */
function isDispatchTierOutlet(outlets, outletId) {
  const t = outlets && outlets[outletId] && outlets[outletId].tier;
  return typeof t === 'number' && t <= 2;
}

/**
 * Classify a single missing (show, outlet) cell. Pure.
 * @param {object} c
 *   { noReviewExpected:boolean, suppressed:boolean, clockAgeHours:number|null }
 * @returns {'IN_FLIGHT'|'GAP'|'NO_REVIEW_EXPECTED'|'SUPPRESSED'}
 */
function classifyCell(c) {
  if (c.noReviewExpected) return 'NO_REVIEW_EXPECTED';
  if (c.suppressed) return 'SUPPRESSED';
  // No measurable clock (missing/suspect date → S2-T6 unmeasurable) means we can't
  // claim the 24h grace has elapsed; treat as IN_FLIGHT so it never counts against
  // the SLA until a real clock exists.
  if (c.clockAgeHours == null) return 'IN_FLIGHT';
  return c.clockAgeHours < GRACE_HOURS ? 'IN_FLIGHT' : 'GAP';
}

/**
 * Merge freshly-observed cells with the prior ledger, preserving each gap's
 * immutable firstSeenAt so consecutive runs on unchanged data produce identical
 * output. New cells get firstSeenAt = nowIso; cells no longer present are dropped.
 *
 * @param {object} prev   previous ledger object (or {})
 * @param {Array<object>} freshShows
 *   [{ showId, title, market, openingDate, cells:[{ outletId, state, url }] }]
 * @param {string} nowIso ISO timestamp for NEW cells only
 * @returns {object} ledger { shows: { [showId]: { ...meta, cells: { [outletId]: {state, firstSeenAt, url} } } } }
 */
function mergeLedger(prev, freshShows, nowIso) {
  const prevShows = (prev && prev.shows) || {};
  const out = {};
  for (const s of freshShows) {
    if (!s.cells || s.cells.length === 0) continue;
    const prevCells = (prevShows[s.showId] && prevShows[s.showId].cells) || {};
    const cells = {};
    for (const cell of s.cells) {
      const was = prevCells[cell.outletId];
      cells[cell.outletId] = {
        state: cell.state,
        // firstSeenAt is the gap's birth: preserved across runs, set once.
        firstSeenAt: (was && was.firstSeenAt) || nowIso,
        ...(cell.url ? { url: cell.url } : {}),
      };
    }
    out[s.showId] = {
      title: s.title,
      market: s.market,
      openingDate: s.openingDate || null,
      cells,
    };
  }
  return { shows: out };
}

// Recursively sort object keys so JSON.stringify is byte-stable regardless of
// insertion order (the commit-on-change contract). Arrays keep their order.
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

/** Deterministic serialization — identical input → identical bytes. */
function serializeLedger(ledger) {
  return JSON.stringify(sortDeep(ledger), null, 2) + '\n';
}

module.exports = { classifyCell, mergeLedger, serializeLedger, isDispatchTierOutlet, GRACE_HOURS };
