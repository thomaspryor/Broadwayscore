'use strict';
/**
 * prior-run-republish-guard — body-text detector for a review of an EARLIER
 * production that was republished/updated with a new date (BRO-4641).
 *
 * Case: slam-frank-off-broadway-2026 (Orpheum, previews 2026-09-17). The Jewish
 * Voice republished its 2025 Asylum Theater review dated 2026-06-12 with
 * "[Updated June 2026] ... Our review is based on the 2025 performance at the
 * Asylum Theater". The publishDate was an llm-scoring guess before the pre-window,
 * so date-guard.guardPublishDate (BRO-4473) swapped it for the fetch date
 * (in-window) and every date guard passed. A date can never catch this: the page
 * really was republished. Only the body says which production it reviews.
 *
 * Fires only on explicit "this review is based on the <year> ..." basis phrases,
 * a "This review is from <year>." carry-forward note (Time Out),
 * or a "<show> was at: <venue> ... through <date>" header whose year/date
 * precedes the current production. A passing mention of a past run in a genuine
 * review ("after its 2025 run at the Asylum") does not match. Shows with a
 * declared priorRuns/tourLegs are skipped: a prior run there is the same
 * production's own coverage.
 *
 * Pure: no I/O.
 */

const { earliestShowDate } = require('./date-guard');

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// "review is based on the 2025 performance|production|run|staging|..."
const BASIS_YEAR_RE = new RegExp(
  '\\b(?:our|this|my|the)\\s+review\\s+(?:is|was)\\s+based\\s+on\\s+(?:the\\s+|a\\s+)?((?:19|20)\\d{2})\\s+' +
  '(?:[A-Za-z\\-]+\\s+){0,2}?(?:performance|production|run|staging|engagement|season|revival|premiere|presentation|showing)\\b', 'i');

// Time Out keeps one evergreen url per title and re-dates it when a show
// returns, leaving "This review is from 2025." above the old text (An Oak Tree,
// The Other Palace 2026 carried Tim Bano's 2025 Young Vic review; BRO-4956).
const REVIEW_FROM_YEAR_RE = /\bthis\s+review\s+(?:is|was)\s+(?:originally\s+)?(?:from|(?:first\s+)?published\s+in|written\s+in)\s+((?:19|20)\d{2})\b/i;

// "reviewed/seen at the <year> ..." is too loose; only the explicit basis form above is used for years.
// "<Title> was at: <Venue> ... through <Month D, YYYY>" / "...closing <Month D, YYYY>"
const WAS_AT_THROUGH_RE = new RegExp(
  '\\bwas\\s+at\\s*:\\s*[^.\\n]{0,120}?\\b(?:through|until|closed|closing)\\s+(' + MONTHS + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})\\b', 'i');

function ymd(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * @param {object} args
 * @param {string} args.text - review fullText
 * @param {object} args.show - shows.json record
 * @returns {{ flag: boolean, reason: string|null, evidence: string|null }}
 */
function detectPriorRunRepublish({ text, show }) {
  const none = { flag: false, reason: null, evidence: null };
  if (!text || !show) return none;
  if ((show.priorRuns && show.priorRuns.length) || (show.tourLegs && show.tourLegs.length)) return none;
  const earliest = earliestShowDate(show);
  if (!earliest) return none;
  const earliestYear = +earliest.slice(0, 4);
  // Basis phrases and run headers live at the top of an article; bounding the scan
  // keeps a late comparison paragraph from tripping it.
  const head = String(text).slice(0, 4000);

  const basis = head.match(BASIS_YEAR_RE);
  if (basis && +basis[1] < earliestYear) {
    return { flag: true, reason: 'based-on-prior-year-production', evidence: basis[0] };
  }

  const fromYear = head.match(REVIEW_FROM_YEAR_RE);
  if (fromYear && +fromYear[1] < earliestYear) {
    return { flag: true, reason: 'review-from-prior-year', evidence: fromYear[0] };
  }

  const wasAt = head.match(WAS_AT_THROUGH_RE);
  // The header must be about THIS show: a sidebar "<other show> was at: ..." on a
  // blog template must not trigger it.
  const lead = wasAt ? head.slice(Math.max(0, wasAt.index - 80), wasAt.index).toLowerCase() : '';
  const baseTitle = String(show.title || '').replace(/\s*\(.*?\)/g, '').trim().toLowerCase();
  if (wasAt && baseTitle && lead.includes(baseTitle)) {
    const mon = MONTH_NUM[wasAt[1].toLowerCase().slice(0, wasAt[1].toLowerCase() === 'sept' ? 4 : 3)];
    const iso = ymd(+wasAt[3], mon, +wasAt[2]);
    if (mon && iso < earliest) {
      return { flag: true, reason: 'prior-run-ended-before-previews', evidence: wasAt[0] };
    }
  }
  return none;
}

/**
 * True when a file flagged by this guard should be released: the detector no
 * longer matches (refetched body, or show gained priorRuns) and no operator
 * decision (manual clear / override / human review / allowEarlyDate) is on it.
 */
function shouldReleasePriorRunRepublish(d, show) {
  if (!d || d.wrongProduction !== true || d.wrongProductionReason !== 'prior-run-republish') return false;
  if (d.wrongProductionManualClear || d.wrongProductionOverride || d.humanReviewedWrongProduction !== undefined || d.allowEarlyDate) return false;
  return !detectPriorRunRepublish({ text: d.fullText, show }).flag;
}

module.exports = { detectPriorRunRepublish, shouldReleasePriorRunRepublish };
