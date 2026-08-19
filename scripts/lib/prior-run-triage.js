'use strict';

/**
 * BRO-80 — classification core for triage-unopened-shows.mjs.
 *
 * The pre-opening temporal gate (review-guards.js isPrematureReviewForUnopenedShow,
 * 2026-07-21) excludes reviews published long before a never-opened show's own
 * previews/opening window. That's correct when the reviews belong to a DIFFERENT
 * production of the same title (aggregator title-match contamination), but wrong
 * when they belong to an EARLIER RUN of the same production that hasn't had
 * priorRuns declared on its shows.json entry yet — those reviews are legitimate
 * and the fix is a priorRuns declaration, not the gate.
 *
 * This module is pure — no I/O — so it can be unit tested directly. The CLI
 * (triage-unopened-shows.mjs) does the file reads and calls classifyPriorRunCandidate.
 */

const SINGLE_RUN_MAX_SPAN_DAYS = 120;
const CONTAMINATION_FLAG_RATIO = 0.5;

/**
 * @param {string} publishDate
 * @returns {number|null} ms since epoch, or null if unparseable
 */
function parseMs(publishDate) {
  const ms = new Date(publishDate).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Loose venue-name canonicalizer: lowercase, drop "theatre"/"theater"/"the"
 * and punctuation, so "Ambassadors Theatre" and "the Ambassadors" both reduce
 * to "ambassadors". Deliberately coarse — a false venue match only adds a
 * supporting signal, never the sole basis for a verdict.
 */
function canonicalizeVenue(venue) {
  return String(venue || '')
    .toLowerCase()
    .replace(/\btheatre\b|\btheater\b|\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fullTextMentionsVenue(fullText, venue) {
  const canon = canonicalizeVenue(venue);
  if (!canon || canon.length < 3) return false;
  const canonText = canonicalizeVenue(fullText || '');
  return canonText.includes(canon);
}

/**
 * Build the per-show descriptor list this module classifies. Kept separate
 * from file I/O: callers pass one { outletId, criticName, publishDate, url,
 * wrongProduction, wrongShow, fullText } object per premature-and-scored
 * review file already selected via review-guards' isPrematureReviewForUnopenedShow
 * + hasValidScore (the CLI does that selection since it needs the show +
 * fs access review-guards requires).
 *
 * @param {{ id: string, venue?: string, market?: string, status?: string }} show
 * @param {Array<{ outletId?: string, criticName?: string, publishDate?: string,
 *   url?: string, wrongProduction?: boolean, wrongShow?: boolean, fullText?: string,
 *   file?: string }>} reviews
 * @returns {{
 *   verdict: 'likely-contamination'|'likely-single-prior-run'|'needs-human-review',
 *   reasoning: string,
 *   stats: { count: number, distinctYears: number[], spanDays: number|null,
 *     flaggedCount: number, venueMentionCount: number },
 *   suggestedPriorRun: { venue?: string, reviewDateRangeStart: string|null,
 *     reviewDateRangeEnd: string|null, note: string } | null,
 * }}
 */
function classifyPriorRunCandidate(show, reviews) {
  const list = Array.isArray(reviews) ? reviews.filter(Boolean) : [];
  const count = list.length;
  if (count === 0) {
    return {
      verdict: 'needs-human-review',
      reasoning: 'No premature-scored review files supplied.',
      stats: { count: 0, distinctYears: [], spanDays: null, flaggedCount: 0, venueMentionCount: 0 },
      suggestedPriorRun: null,
    };
  }

  const msList = list.map(r => parseMs(r.publishDate)).filter(ms => ms != null);
  const distinctYears = Array.from(
    new Set(list.map(r => (r.publishDate ? String(r.publishDate).slice(0, 4) : null)).filter(Boolean))
  ).sort();
  const spanDays = msList.length >= 2
    ? Math.round((Math.max(...msList) - Math.min(...msList)) / 86400000)
    : msList.length === 1 ? 0 : null;

  const flaggedCount = list.filter(r => r.wrongProduction === true || r.wrongShow === true).length;

  const realVenue = show && show.venue && String(show.venue).trim() && String(show.venue).trim().toUpperCase() !== 'TBA'
    ? show.venue
    : null;
  const venueMentionCount = realVenue
    ? list.filter(r => fullTextMentionsVenue(r.fullText, realVenue)).length
    : 0;

  const earliestIso = msList.length ? new Date(Math.min(...msList)).toISOString().slice(0, 10) : null;
  const latestIso = msList.length ? new Date(Math.max(...msList)).toISOString().slice(0, 10) : null;

  // Priority 1: a majority of these files are ALREADY independently flagged
  // wrongProduction/wrongShow by another guard — the temporal gate is redundant
  // with an existing contamination finding, not the discovery of a new legit run.
  if (count > 0 && flaggedCount / count >= CONTAMINATION_FLAG_RATIO) {
    return {
      verdict: 'likely-contamination',
      reasoning: `${flaggedCount}/${count} files already carry wrongProduction/wrongShow flags — the temporal gate is corroborating an existing contamination finding, not surfacing a new prior run.`,
      stats: { count, distinctYears, spanDays, flaggedCount, venueMentionCount },
      suggestedPriorRun: null,
    };
  }

  // Priority 2: a single tight cluster (one calendar year, <=120 days apart)
  // reads like one earlier run of the same production.
  if (distinctYears.length === 1 && spanDays != null && spanDays <= SINGLE_RUN_MAX_SPAN_DAYS) {
    const venueNote = realVenue
      ? (venueMentionCount > 0
        ? `${venueMentionCount}/${count} review texts mention the show's own venue ("${show.venue}") — supports same-venue return.`
        : `none of the ${count} review texts mention the show's own venue ("${show.venue}") — verify venue before declaring.`)
      : 'show has no venue on file (TBA) — venue signal unavailable.';
    return {
      verdict: 'likely-single-prior-run',
      reasoning: `${count} premature-scored reviews cluster in ${distinctYears[0]} within a ${spanDays}-day window (single run pattern), ${flaggedCount} already flagged. ${venueNote}`,
      stats: { count, distinctYears, spanDays, flaggedCount, venueMentionCount },
      suggestedPriorRun: {
        venue: realVenue || undefined,
        reviewDateRangeStart: earliestIso,
        reviewDateRangeEnd: latestIso,
        note: 'reviewDateRange is derived from review publish dates, NOT the run\'s real opening/closing dates — confirm actual dates via Playbill/IBDB before declaring show.priorRuns.',
      },
    };
  }

  // Priority 3: everything else — multiple distinct year-clusters (could be
  // several legit prior runs OR multi-production contamination), or a single
  // year with a suspiciously wide span. Needs a human to read the reviews.
  return {
    verdict: 'needs-human-review',
    reasoning: distinctYears.length > 1
      ? `Premature-scored reviews span ${distinctYears.length} distinct years (${distinctYears.join(', ')}) — could be multiple legitimate prior runs or multi-production contamination; read the texts before deciding.`
      : `${count} reviews in ${distinctYears[0] || 'unknown year'} span ${spanDays}d, wider than the ${SINGLE_RUN_MAX_SPAN_DAYS}d single-run heuristic — verify before declaring a single prior run.`,
    stats: { count, distinctYears, spanDays, flaggedCount, venueMentionCount },
    suggestedPriorRun: null,
  };
}

module.exports = {
  classifyPriorRunCandidate,
  canonicalizeVenue,
  fullTextMentionsVenue,
  SINGLE_RUN_MAX_SPAN_DAYS,
  CONTAMINATION_FLAG_RATIO,
};
