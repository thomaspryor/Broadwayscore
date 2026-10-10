'use strict';

// When may the recoupment model's "% returned" bar be shown, and what does
// it read? (BRO-4989, checker decision #5, 2026-10-10.) One rule for the
// shadow report (scripts/shadow-display-guard.js) and the site
// (src/lib/commercial-display.ts).
//
// Hidden when any of:
//   few-weeks       fewer than 12 weeks played: too early to mean anything
//   out-of-bounds   central outside [-25, 150]: the model is off its rails
//                   (Schmigadoon -169)
//   off-report      a reported range exists (not our own inference) and the
//                   central is more than 25 points outside it
// Otherwise shown. An investor cannot get back less than nothing, so a
// negative value displays as 0 with "running below its costs"; the negative
// number stays internal.

const { runWindow } = require('./run-window');
// Our own "Inferred:"/"Estimated:" figures are not a report.
const { OWN_INFERENCE } = require('./recoupment-ground-truth');

const MIN_PLAYED_WEEKS = 12;
const CENTRAL_MIN = -25;
const CENTRAL_MAX = 150;
const MAX_OFF_REPORT = 25;

/** Weeks played so far (previews included, COVID dark weeks excluded). */
function playedWeeks(show, now = new Date()) {
  if (!show || !(show.previewsStartDate || show.openingDate)) return 0;
  return Math.max(0, runWindow(show, { now, playedOnly: true }).totalRunWeeks);
}

/** The reported [lo, hi] when it comes from a report, else null. */
function reportedRange(comm) {
  const est = comm && comm.estimatedRecoupmentPct;
  const basis = comm && (comm.estimatedRecoupmentSource || comm.notes);
  if (!Array.isArray(est) || est.length !== 2 || !est.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (!basis || OWN_INFERENCE.test(basis)) return null;
  return [Math.min(...est), Math.max(...est)];
}

/**
 * @param {{ pct: [number, number, number] | null | undefined, playedWeeks: number, reported?: [number, number] | null }} input
 * @returns {{ show: boolean, reason: null | 'no-model' | 'few-weeks' | 'out-of-bounds' | 'off-report', shown: [number, number, number] | null, belowCosts: boolean }}
 */
function modelDisplayGuard({ pct, playedWeeks: weeks, reported = null }) {
  const hide = (reason) => ({ show: false, reason, shown: null, belowCosts: false });
  if (!Array.isArray(pct) || pct.length !== 3 || !pct.every((v) => typeof v === 'number' && Number.isFinite(v))) return hide('no-model');
  const central = pct[1];
  if (!(weeks >= MIN_PLAYED_WEEKS)) return hide('few-weeks');
  if (central < CENTRAL_MIN || central > CENTRAL_MAX) return hide('out-of-bounds');
  if (reported) {
    const off = central < reported[0] ? reported[0] - central : central > reported[1] ? central - reported[1] : 0;
    if (off > MAX_OFF_REPORT) return hide('off-report');
  }
  return { show: true, reason: null, shown: pct.map((v) => Math.max(0, v)), belowCosts: central < 0 };
}

module.exports = {
  modelDisplayGuard, playedWeeks, reportedRange,
  MIN_PLAYED_WEEKS, CENTRAL_MIN, CENTRAL_MAX, MAX_OFF_REPORT,
};
