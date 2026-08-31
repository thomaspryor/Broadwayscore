/**
 * Pure comparison logic for validate-show-venue.js — extracted per CLAUDE.md
 * §15 (test extraction pattern: pure decision functions live in scripts/lib/
 * so tests require() the real function instead of re-implementing it).
 *
 * Compares a shows.json entry against a parsed Playbill production page and
 * reports mismatches on venue / opening-year / openingDate / closingDate /
 * isRevival.
 */

'use strict';

const { canonicalVenue } = require('./title-match');
const { venuesMatch } = require('./deduplication');

const DATE_DELTA_DAYS = 30;

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return null;
  return Math.round(Math.abs((db - da) / 86400000));
}

function urlYear(url) {
  const m = url.match(/-(\d{4})(?:[\/?#]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Does show.priorRuns contain an entry whose venue AND at least one date
 * corroborate what Playbill's page describes? When yes, Playbill's indexed
 * production page is validating a PRIOR run of this same recurring/remounted
 * production, not shows.json's CURRENT dates — so a venue/opening-year/
 * openingDate/closingDate "mismatch" against that page is explained, not a
 * data error (BRO-2544: The Dead, 1904's 2026 remount vs Playbill's
 * still-indexed 2024 page; Bedlam's Othello Nov 2026 encore vs Playbill's
 * page for the May 2026 original run — Playbill hadn't indexed a
 * remount-specific page for either as of 2026-08-30).
 *
 * Reuses the same `priorRuns` field gather-reviews.js/rebuild-all-reviews.js
 * already read to re-include a prior run's reviews (CLAUDE.md "Returning
 * production → priorRuns") instead of inventing a second recurring-show
 * marker or a bare bypass flag.
 *
 * Deliberately requires an ACTUAL corroborating match — venue equality via
 * venuesMatch() AND at least one date within DATE_DELTA_DAYS — not just
 * "priorRuns is non-empty". An unrelated or wrong priorRuns entry (or one
 * that doesn't actually match what Playbill says) must not blanket-suppress
 * a real mismatch; this is a self-verifying corroboration, not a bypass.
 *
 * @returns {object|null} the matching priorRuns entry, or null
 */
function findCorroboratingPriorRun(show, parsed) {
  const priorRuns = Array.isArray(show?.priorRuns) ? show.priorRuns : [];
  const pbVenue = parsed?.titleParse?.venue;
  if (!priorRuns.length || !pbVenue) return null;
  return priorRuns.find(run => {
    if (!run || !run.venue || !venuesMatch(run.venue, pbVenue)) return false;
    const openDelta = daysBetween(run.openingDate, parsed.dates?.openingDate);
    const closeDelta = daysBetween(run.closingDate, parsed.dates?.closingDate);
    return (openDelta !== null && openDelta <= DATE_DELTA_DAYS)
        || (closeDelta !== null && closeDelta <= DATE_DELTA_DAYS);
  }) || null;
}

const PRIOR_RUN_EXPLAINABLE_FIELDS = new Set(['venue', 'opening-year', 'openingDate', 'closingDate']);

/**
 * @param {object} show shows.json entry
 * @param {object} parsed { titleParse, dates, tagLine } from validate-show-venue.js
 * @param {string} playbillUrl the Playbill production URL that was fetched
 * @returns {{ mismatches: object[], explainedByPriorRun: object[] }}
 */
function compareShow(show, parsed, playbillUrl) {
  const mismatches = [];
  const explainedByPriorRun = [];
  const corroboratingPriorRun = findCorroboratingPriorRun(show, parsed);
  const record = (m) => {
    if (corroboratingPriorRun && PRIOR_RUN_EXPLAINABLE_FIELDS.has(m.field)) {
      explainedByPriorRun.push({ ...m, priorRun: corroboratingPriorRun });
    } else {
      mismatches.push(m);
    }
  };
  const showVenueCanon = canonicalVenue(show.venue || '');
  const pageVenueCanon = canonicalVenue(parsed.titleParse?.venue || '');
  // The actual mismatch decision uses venuesMatch(), not the showVenueCanon/
  // pageVenueCanon equality above (those two stay as display-only fields in
  // the audit record below) — canonicalVenue()'s fallback for a venue
  // outside VENUE_ALIASES is just the lowercased FIRST WORD, so two
  // genuinely different venues sharing a leading word ("The X") would
  // silently PASS this check as "not a mismatch" (BRO-243). That's the wrong
  // direction of error for a venue-mismatch DETECTOR — false negatives are
  // exactly what this script exists to catch.
  if (show.venue && parsed.titleParse?.venue && !venuesMatch(show.venue, parsed.titleParse.venue)) {
    record({
      field: 'venue',
      shows: show.venue,
      showsCanonical: showVenueCanon,
      playbill: parsed.titleParse?.venue,
      playbillCanonical: pageVenueCanon,
    });
  }

  // Year: prefer URL year (always present); cross-check with title year.
  const pbYear = urlYear(playbillUrl) || parsed.titleParse?.year || null;
  const showYear = (() => {
    if (show.openingDate) return parseInt(show.openingDate.slice(0, 4), 10);
    const idy = (show.id || '').match(/\d{4}/);
    return idy ? parseInt(idy[0], 10) : null;
  })();
  if (pbYear && showYear && pbYear !== showYear) {
    record({ field: 'opening-year', shows: showYear, playbill: pbYear });
  }

  // Date deltas (only when both ends are known).
  if (show.openingDate && parsed.dates?.openingDate) {
    const delta = daysBetween(show.openingDate, parsed.dates.openingDate);
    if (delta !== null && delta > DATE_DELTA_DAYS) {
      record({
        field: 'openingDate',
        shows: show.openingDate,
        playbill: parsed.dates.openingDate,
        deltaDays: delta,
      });
    }
  }
  if (show.closingDate && parsed.dates?.closingDate) {
    const delta = daysBetween(show.closingDate, parsed.dates.closingDate);
    if (delta !== null && delta > DATE_DELTA_DAYS) {
      record({
        field: 'closingDate',
        shows: show.closingDate,
        playbill: parsed.dates.closingDate,
        deltaDays: delta,
      });
    }
  }

  // Revival status: Playbill prints "Revival" or "Original" on every
  // production page it has classified — authoritative, not a title
  // heuristic. Catches both directions of BRO-2023: a prior production this
  // corpus never recorded (Playbill says Revival, shows.json says false) and
  // a same-title transfer misread as a revival (Playbill says Original,
  // shows.json says true). Not priorRun-explainable — isRevival is a
  // structural fact about the production, not a run-specific date/venue.
  if (parsed.tagLine && parsed.tagLine.revivalStatus !== 'unknown') {
    const playbillIsRevival = parsed.tagLine.revivalStatus === 'revival';
    if (!!show.isRevival !== playbillIsRevival) {
      mismatches.push({
        field: 'isRevival',
        shows: !!show.isRevival,
        playbill: playbillIsRevival,
      });
    }
  }
  return { mismatches, explainedByPriorRun };
}

module.exports = {
  DATE_DELTA_DAYS,
  daysBetween,
  urlYear,
  findCorroboratingPriorRun,
  compareShow,
};
