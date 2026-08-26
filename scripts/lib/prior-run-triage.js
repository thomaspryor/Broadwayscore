'use strict';

const { foldDiacritics } = require('./title-match');

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
 *
 * // venue-write-guard-ok: suggestedPriorRun.venue is read-only report output for
 * a human to confirm via Playbill/IBDB before declaring show.priorRuns — this module
 * never writes shows.json (see triage-unopened-shows.mjs header).
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
  return foldDiacritics(String(venue || '').toLowerCase())
    .replace(/\btheatre\b|\btheater\b|\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function fullTextMentionsVenue(fullText, venue) {
  const canon = canonicalizeVenue(venue);
  // Below 5 chars a canonicalized venue token collides with common English
  // words/phrases ("Park Theatre" -> "park", which matches "in the park" in
  // unrelated prose) — too short to trust as a supporting signal.
  if (!canon || canon.length < 5) return false;
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
  // Derived from the parsed ms value (not a raw string slice) so a
  // non-ISO-but-JS-parseable publishDate ("8/1/2025") reports its real year
  // instead of a garbage slice of the raw string.
  const distinctYears = Array.from(new Set(msList.map(ms => new Date(ms).getUTCFullYear()))).sort();
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

  // Priority 1: at least 2 of these files are ALREADY independently flagged
  // wrongProduction/wrongShow by another guard (majority AND a floor of 2 —
  // a single stale/misapplied flag out of a 2-file show must not, by itself,
  // suppress a real prior-run investigation; those flags have a known ~15%
  // false-positive rate, see memory/feedback_llm_wrongprod_false_positives.md)
  // — the temporal gate is redundant with an existing contamination finding,
  // not the discovery of a new legit run. Still worth a human spot-check.
  if (flaggedCount >= 2 && flaggedCount / count >= CONTAMINATION_FLAG_RATIO) {
    return {
      verdict: 'likely-contamination',
      reasoning: `${flaggedCount}/${count} files already carry wrongProduction/wrongShow flags — the temporal gate is corroborating an existing contamination finding, not surfacing a new prior run. wrongProduction has a known ~15% false-positive rate, so a quick spot-check is still worthwhile before treating this as closed.`,
      stats: { count, distinctYears, spanDays, flaggedCount, venueMentionCount },
      suggestedPriorRun: null,
    };
  }

  // Priority 2: a tight cluster (<=120 days apart, regardless of whether that
  // span happens to cross a Dec/Jan calendar-year boundary — a real preview
  // run frequently does) reads like one earlier run of the same production.
  // A single review is weak evidence on its own (one bad publishDate, one
  // stray title-collision article) — it only counts as a cluster when a
  // second independent signal (an actual venue mention in the text) backs it.
  const isTightCluster = spanDays != null && spanDays <= SINGLE_RUN_MAX_SPAN_DAYS;
  const singleReviewNeedsVenueConfirm = count === 1 && venueMentionCount === 0;
  if (isTightCluster && !singleReviewNeedsVenueConfirm) {
    const venueNote = realVenue
      ? (venueMentionCount > 0
        ? `${venueMentionCount}/${count} review texts mention the show's own venue ("${show.venue}") — supports same-venue return.`
        : `none of the ${count} review texts mention the show's own venue ("${show.venue}") — verify venue before declaring.`)
      : 'show has no venue on file (TBA) — venue signal unavailable.';
    return {
      verdict: 'likely-single-prior-run',
      reasoning: `${count} premature-scored review(s) cluster within a ${spanDays}-day window (single run pattern), ${flaggedCount} already flagged. ${venueNote}`,
      stats: { count, distinctYears, spanDays, flaggedCount, venueMentionCount },
      suggestedPriorRun: {
        venue: realVenue || undefined,
        reviewDateRangeStart: earliestIso,
        reviewDateRangeEnd: latestIso,
        note: 'reviewDateRange is derived from review publish dates, NOT the run\'s real opening/closing dates — confirm actual dates via Playbill/IBDB before declaring show.priorRuns.',
      },
    };
  }

  // Priority 3: everything else — reviews spread wider than one run's window,
  // or a lone review with no venue corroboration. Needs a human to read the
  // texts before deciding whether this is one run, several, or contamination.
  return {
    verdict: 'needs-human-review',
    reasoning: singleReviewNeedsVenueConfirm
      ? `Only 1 premature-scored review and its text doesn't mention the show's own venue ("${realVenue || 'TBA'}") — too little evidence to call this a prior run on its own; read the review before deciding.`
      : distinctYears.length > 1
        ? `Premature-scored reviews span ${distinctYears.length} distinct years (${distinctYears.join(', ')}) and ${spanDays}d — could be multiple legitimate prior runs or multi-production contamination; read the texts before deciding.`
        : `${count} reviews span ${spanDays}d, wider than the ${SINGLE_RUN_MAX_SPAN_DAYS}d single-run heuristic — verify before declaring a single prior run.`,
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
