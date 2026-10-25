'use strict';
/**
 * run-contamination — pure decisions behind the "reviews of another run /
 * another production counted toward this show" audit (BRO-4998, BRO-5000).
 *
 * The 2026-10-05 newsletter week showed five ways a review of a DIFFERENT run
 * (or a wrong date) reached a score. The per-show fixes shipped one by one; the
 * functions here are the shared, tested predicates the audit script and the
 * rebuild's inclusion path both call, so the class is caught in one place.
 *
 * Pure: no I/O.
 */

const { earliestShowDate } = require('./date-guard');
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');

// A page that says outright it was written for an earlier year. "This review is
// from 2025" (An Oak Tree, Time Out) and "Originally published ... 2019" are
// the shapes seen; every pattern needs a four-digit year within a short span so
// a play's own history ("first published in 1962") cannot match.
const REPUBLISH_PATTERNS = [
  /\bthis (?:review|article|piece|post|story|interview) (?:is|was) (?:originally |first )?(?:from|published|written|posted)(?: in| on)?\s+(?:[A-Za-z]+\.? )?(?:\d{1,2}(?:st|nd|rd|th)?,? )?(?:[A-Za-z]+\.? )?\b((?:19|20)\d{2})\b/i,
  // "Originally published in The Guardian, 12 May 2021". A month name must sit before
  // the year: "first published in Italy in 1957" is a play's own history, not a dateline.
  /\b(?:originally|first) (?:published|posted)\s+(?:in|on|at)\s+[^.\n]{0,50}?\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+(?:\d{1,2}(?:st|nd|rd|th)?,?\s+)?((?:19|20)\d{2})\b/i,
  /\b(?:originally|first) (?:published|posted)\s+(?:in|on|at)\s+[^.\n]{0,50}?\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+((?:19|20)\d{2})\b/i,
  /\brepublished (?:from|in|on)\b[^.\n]{0,40}?\b((?:19|20)\d{2})\b/i,
  /\bfrom the archive[^.\n]{0,40}?\b((?:19|20)\d{2})\b/i,
];

// Words that mean the sentence is about the work, not the article.
const WORK_HISTORY_RE = /\b(?:novel|play|book|musical|film|album|volume|poem|short story|script|memoir|story|score|libretto|opera)\b/i;

// Banner text sits at the top or bottom of an article; scanning the middle
// would match a critic's own history lesson.
const HEAD_CHARS = 1500;
const TAIL_CHARS = 700;

/**
 * Earliest year a "republished / originally published" notice in `text` names.
 * @param {string} text
 * @returns {{year: number, snippet: string}|null}
 */
function republishMarker(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const segments = [text.slice(0, HEAD_CHARS)];
  if (text.length > HEAD_CHARS) segments.push(text.slice(Math.max(HEAD_CHARS, text.length - TAIL_CHARS)));
  let best = null;
  for (const seg of segments) {
    for (const re of REPUBLISH_PATTERNS) {
      const m = re.exec(seg);
      if (!m) continue;
      if (WORK_HISTORY_RE.test(m[0])) continue;
      const year = parseInt(m[m.length - 1], 10);
      if (!best || year < best.year) best = { year, snippet: m[0].replace(/\s+/g, ' ').slice(0, 120) };
    }
  }
  return best;
}

/**
 * Is a review whose page text announces an earlier year, on a show that did not
 * exist before that year, another run's review? A declared priorRuns/tourLegs
 * entry covering the named year is the same production's own coverage and stays.
 *
 * @param {object} args
 * @param {string} args.fullText
 * @param {object} args.show shows.json record
 * @returns {{exclude: boolean, markerYear: number|null, snippet: string|null, reason: string|null}}
 */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Month named inside the marker snippet, 1-12, or null when it names only a year.
function markerMonth(snippet) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.exec(snippet || '');
  return m ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : null;
}

function evaluateRepublishedReview({ fullText, show, publishDate }) {
  const none = { exclude: false, markerYear: null, snippet: null, reason: null };
  if (!show) return none;
  const marker = republishMarker(fullText);
  if (!marker) return none;
  const base = { ...none, markerYear: marker.year, snippet: marker.snippet };
  // "Originally Published on January 13, 2013" beside a review dated 2014-01-15 is a
  // year typo on the page (Beautiful, Theater Life), not a republish: the stated day and
  // month land within a week of the review's own date once the year matches.
  const dm = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.exec(marker.snippet);
  const pubMs = Date.parse(String(publishDate || '').slice(0, 10) + 'T00:00:00Z');
  if (dm && !Number.isNaN(pubMs)) {
    const mo = MONTHS.indexOf((dm[1] || dm[4]).toLowerCase()) + 1;
    const day = parseInt(dm[2] || dm[3], 10);
    const sameYear = Date.UTC(new Date(pubMs).getUTCFullYear(), mo - 1, day);
    if (Math.abs(sameYear - pubMs) <= 7 * 86400000) return { ...base, reason: 'year-typo-matches-publish-date' };
  }
  const earliest = earliestShowDate(show);
  if (!earliest) return base;
  const earliestMs = Date.parse(`${String(earliest).slice(0, 10)}T00:00:00Z`);
  const month = markerMonth(marker.snippet);
  // With a month, the stated date must sit more than 35 days before the show's first date
  // (the date-guard's widest grace); with a year only, the whole year must precede it.
  const statedMs = month ? Date.UTC(marker.year, month - 1, 15) : Date.UTC(marker.year, 11, 31);
  if (!(statedMs < earliestMs - (month ? 35 : 0) * 86400000)) return base;
  // A declared prior run or tour leg that overlaps the stated year (or month) is the same
  // production's own coverage. Probe each month so a short early-year run is not missed.
  const probes = month ? [month] : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const covered = probes.some((mo) => {
    const d = new Date(Date.UTC(marker.year, mo - 1, 15));
    return isWithinPriorRun(d, show.priorRuns) || isWithinTourLeg(d, show.tourLegs);
  });
  if (covered) return { ...base, reason: 'covered-by-declared-run' };
  return { ...base, exclude: true, reason: 'republished-from-earlier-year' };
}

const CLEAR_MARKERS = [
  'wrongProductionManualClear', 'wrongProductionOverride',
  'wrongProductionOverrideReason', 'wrongProductionOverrideSetAt', 'wrongProductionOverrideSetBy',
  'wrongProductionClearedNote',
];

/**
 * A record that says "wrong production" and "cleared" at once. The effective
 * state is cleared (isEffectivelyWrongProduction reads the override first), so
 * a later human flag silently loses to an earlier script's clear (An Oak Tree,
 * Time Out, 2026-10-10 clear vs 2026-10-11 plan flag).
 *
 * @param {object} d review-text record
 * @returns {{conflict: boolean, flagLater: boolean, markers: string[], clearedBy: string|null}}
 */
function wrongProductionFlagVsClear(d) {
  if (!d || d.wrongProduction !== true) return { conflict: false, flagLater: false, markers: [], clearedBy: null };
  const markers = ['wrongProductionManualClear', 'wrongProductionOverride'].filter((k) => d[k] === true);
  if (markers.length === 0) return { conflict: false, flagLater: false, markers: [], clearedBy: null };
  // A plan/human flag leaves an approvedFixes entry for wrongProduction.
  const fixes = Array.isArray(d.approvedFixes) ? d.approvedFixes : [];
  const flagFixes = fixes.filter((f) => f && f.field === 'wrongProduction' && f.at && f.newValue !== false);
  const clearAt = Date.parse(d.wrongProductionOverrideSetAt || '') || 0;
  const flagLater = flagFixes.some((f) => (Date.parse(f.at) || 0) > clearAt);
  return {
    conflict: true,
    flagLater,
    markers,
    clearedBy: d.wrongProductionOverrideSetBy || null,
  };
}

/**
 * True when a plan/human flag was set after a SCRIPT's clear and the clear markers still
 * hide it. Only script clears qualify (wrongProductionOverrideSetBy names a .js file);
 * a human clear is a verdict the flag does not overrule.
 */
function humanFlagOutranksScriptClear(d) {
  const r = wrongProductionFlagVsClear(d);
  return r.conflict && r.flagLater && require('./review-write-guard').isScriptWrongProductionClear(d);
}

module.exports = {
  humanFlagOutranksScriptClear,
  republishMarker,
  evaluateRepublishedReview,
  wrongProductionFlagVsClear,
  CLEAR_MARKERS,
};
