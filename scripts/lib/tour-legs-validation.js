/**
 * Validation rails for show.tourLegs (Coverage Verdict S4 — returning-production
 * protocol). Pure decision functions used by validate-data.js and unit-tested
 * directly (tests/unit/tour-legs-validation.test.mjs).
 *
 * Two rejections, per the plan (§S4):
 *   1. A leg must carry a corroborationUrl — no leg declared from memory.
 *   2. A leg cannot overlap a declared priorRuns window at the SAME venue —
 *      tourLegs describe stops of the CURRENT production; an overlapping
 *      window at the same venue means the data is describing two different
 *      things at once (a past distinct production AND a current tour leg,
 *      same place, same time), which is self-contradictory and would let a
 *      prior production's reviews masquerade as current-run coverage via the
 *      tourLeg exemption in wrong-production-autoclear.js.
 */

const { parseDate } = require('./date-utils');

function normalizeVenue(venue) {
  return String(venue || '').trim().toLowerCase();
}

function legWindow(leg) {
  const start = parseDate(leg.startDate);
  if (!start || isNaN(start.getTime())) return null;
  let end = null;
  if (leg.endDate) {
    end = parseDate(leg.endDate);
    if (!end || isNaN(end.getTime())) end = null;
  }
  if (!end) {
    end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + 180);
  }
  return { start, end };
}

function priorRunWindow(run) {
  if (!run || !run.openingDate) return null;
  const open = parseDate(run.openingDate);
  if (!open || isNaN(open.getTime())) return null;
  let close = null;
  if (run.closingDate) {
    close = parseDate(run.closingDate);
    if (!close || isNaN(close.getTime())) close = null;
  }
  if (!close) {
    close = new Date(open.getTime());
    close.setUTCDate(close.getUTCDate() + 180);
  }
  return { start: open, end: close };
}

function windowsOverlap(a, b) {
  return a.start.getTime() <= b.end.getTime() && b.start.getTime() <= a.end.getTime();
}

/**
 * True when `leg` is missing a non-empty corroborationUrl. Legs cannot be
 * declared from memory — every leg needs a URL that proves it happened.
 *
 * @param {{ corroborationUrl?: string }} leg
 * @returns {boolean}
 */
function tourLegMissingCorroboration(leg) {
  return !leg || typeof leg.corroborationUrl !== 'string' || leg.corroborationUrl.trim().length === 0;
}

/**
 * True when `leg`'s date window overlaps any of `priorRuns` at the SAME venue
 * (case/whitespace-insensitive match). A leg or run missing a usable venue or
 * date window never overlaps (nothing to compare).
 *
 * @param {{ venue?: string, startDate?: string, endDate?: string }} leg
 * @param {Array<{venue?: string, openingDate?: string, closingDate?: string}>|undefined} priorRuns
 * @returns {boolean}
 */
function tourLegOverlapsPriorRun(leg, priorRuns) {
  if (!leg || !Array.isArray(priorRuns) || priorRuns.length === 0) return false;
  const legVenue = normalizeVenue(leg.venue);
  if (!legVenue) return false;
  const lw = legWindow(leg);
  if (!lw) return false;

  for (const run of priorRuns) {
    if (!run) continue;
    if (normalizeVenue(run.venue) !== legVenue) continue;
    const rw = priorRunWindow(run);
    if (!rw) continue;
    if (windowsOverlap(lw, rw)) return true;
  }
  return false;
}

/**
 * Validate every tourLeg declared on a show. Returns one issue string per
 * violation (missing corroboration and/or prior-run overlap can both fire for
 * the same leg). Empty array = clean.
 *
 * @param {{ id?: string, tourLegs?: Array<object>, priorRuns?: Array<object> }} show
 * @returns {string[]}
 */
function validateShowTourLegs(show) {
  const issues = [];
  if (!show || !Array.isArray(show.tourLegs) || show.tourLegs.length === 0) return issues;

  show.tourLegs.forEach((leg, i) => {
    const label = `tourLegs[${i}]${leg && leg.venue ? ` (${leg.venue})` : ''}`;
    if (tourLegMissingCorroboration(leg)) {
      issues.push(`${label} is missing a corroborationUrl — tourLegs cannot be declared from memory`);
    }
    if (tourLegOverlapsPriorRun(leg, show.priorRuns)) {
      issues.push(`${label} overlaps a declared priorRuns window at the same venue — a venue stop can't be both a past distinct production and a current tour leg at the same time`);
    }
  });

  return issues;
}

module.exports = {
  tourLegMissingCorroboration,
  tourLegOverlapsPriorRun,
  validateShowTourLegs,
};
