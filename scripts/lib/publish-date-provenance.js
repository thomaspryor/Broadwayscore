'use strict';

/**
 * Publish-date provenance rules (BRO-5081). Pure, no I/O.
 *
 * A review's `publishDate` must be the date the review itself was published,
 * read from the review's own page, URL, JSON-LD or an archive. Two write paths
 * used to put other dates there, and once on disk those dates looked exactly
 * like real ones:
 *
 *  1. The LLM scoring step's guess (ensemble-scorer.ts). Wolf Hall Parts One &
 *     Two (Broadway 2015), The Hollywood Reporter: stored 2015-03-20 (the
 *     first preview), the review ran 2015-04-09.
 *  2. A review-roundup article's own date stamped onto every review it lists
 *     (BroadwayWorld Review Roundup articleBody parsing, WestEndTheatre.com
 *     round-up posts). When We Have Sufficiently Tortured Each Other (West End
 *     2019), BritishTheatre.com: stored 2019-02-07 (the BWW roundup date), the
 *     review ran 2019-01-24.
 *
 * The guess goes to `llmPublishDateGuess` and fills publishDate only near
 * opening; the roundup date stays as publishDate marked 'roundup-article'.
 * Both provisional sources are replaced by the page's own date at the next
 * text fetch (isProvisionalPublishDate).
 */

/** dateSource values that mark a stored publishDate as a placeholder a real page date may replace. */
const PROVISIONAL_DATE_SOURCES = new Set(['llm-scoring', 'roundup-article']);

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** Days after opening during which the scoring guess may still fill publishDate. */
const NEAR_OPENING_DAYS = 60;

/**
 * Is this show at or near its opening (still in previews/upcoming, no valid
 * opening date, opening in the future or within NEAR_OPENING_DAYS)? Pure.
 */
function isNearOpening(show, now = Date.now()) {
  if (!show) return true; // unknown show: keep the old behaviour
  if (show.status === 'previews' || show.status === 'upcoming') return true;
  const opening = Date.parse(String(show.openingDate || ''));
  if (!Number.isFinite(opening)) return true;
  return now - opening <= NEAR_OPENING_DAYS * 864e5;
}

/**
 * Fields the scoring step may write about a dateless review's date. The
 * models' date is a guess (the first valid one, Claude > OpenAI > Gemini >
 * Kimi), so it always goes to `llmPublishDateGuess`.
 *
 * It fills `publishDate` (dateSource 'llm-scoring', provisional: a later page
 * fetch replaces it) only near opening. There a dateless review on a
 * multi-production title that has not opened yet is held as wrongProduction by
 * the dateless-revival guard (date-guard.js), and an opening-night guess is
 * almost always the opening date anyway. For a show that opened long before
 * scoring (the historical backfill) the guess was wrong: Wolf Hall THR got the
 * first preview, 2015-03-20, for a review published 2015-04-09 (BRO-5081).
 *
 * @param {object} review - the review file being scored (reads publishDate)
 * @param {object} modelResults - ensemble modelResults ({claude,openai,gemini,kimi} -> {publishDate})
 * @param {object|null} show - shows.json record (status, openingDate); null = unknown
 * @param {number} [now]
 * @returns {{ llmPublishDateGuess?: string, publishDate?: string, dateSource?: string }}
 */
function llmScoringDateFields(review, modelResults, show = null, now = Date.now()) {
  if (review && review.publishDate) return {};
  const mr = modelResults || {};
  for (const m of ['claude', 'openai', 'gemini', 'kimi']) {
    const d = mr[m] && mr[m].publishDate;
    if (typeof d === 'string' && YMD.test(d)) {
      return isNearOpening(show, now) && isPlausibleGuess(d, show, now)
        ? { llmPublishDateGuess: d, publishDate: d, dateSource: 'llm-scoring' }
        : { llmPublishDateGuess: d };
    }
  }
  return {};
}

/** A guess dated this far before the show's first preview cannot be a review of it (BRO-5397). */
const GUESS_BEFORE_START_DAYS = 60;

/**
 * Is the model's guessed date possible for THIS show? A dateless "Thursday, 4th June" review of a
 * show that opened 2026-05-28 came back as 2024-06-04, and Islington Tribune / Camden New Journal
 * pieces for 2026 shows were stored with 2015, 2021, 2023 and 2024 dates the page never replaced
 * (13 live reviews, BRO-5397). A guess more than 60 days before the show's earliest date (unless a
 * declared prior run covers it) or in the future is kept as `llmPublishDateGuess` only.
 * Unknown show or no show dates: plausible (the old behaviour).
 */
function isPlausibleGuess(dateStr, show, now = Date.now()) {
  const t = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(t)) return false;
  if (t > now + 3 * 864e5) return false; // a review cannot be dated in the future
  if (!show) return true;
  const { earliestShowDate } = require('./date-guard');
  const earliest = Date.parse(`${earliestShowDate(show) || ''}T00:00:00Z`);
  if (!Number.isFinite(earliest)) return true;
  if (t >= earliest - GUESS_BEFORE_START_DAYS * 864e5) return true;
  const { isWithinPriorRun, isWithinOptOutPriorRun } = require('./wrong-production-autoclear');
  // A run that opted out of inheriting reviews (inheritReviews:false) is not this show's.
  return isWithinPriorRun(dateStr, show.priorRuns) && !isWithinOptOutPriorRun(dateStr, show.priorRuns);
}

/**
 * Date fields for one review listed in a roundup article. The roundup's own
 * date is not the review's (When We Have Sufficiently Tortured Each Other:
 * roundup 2019-02-07, review 2019-01-24), but it is within days of it and the
 * production guards (date windows, tour reroutes, dateless-revival hold) need
 * a date, so it stays as publishDate marked dateSource 'roundup-article':
 * provisional, replaced by the review page's own date at the next text fetch
 * (collect-review-texts.js, isProvisionalPublishDate).
 *
 * @param {string|null|undefined} roundupArticleDate - normalized date (or null)
 * @returns {{ publishDate: string|null, dateSource?: string }}
 */
function roundupEntryDateFields(roundupArticleDate) {
  if (!roundupArticleDate) return { publishDate: null };
  return { publishDate: roundupArticleDate, dateSource: 'roundup-article' };
}

/**
 * True when the stored publishDate is a placeholder (see PROVISIONAL_DATE_SOURCES)
 * that a date read from the review's own page should replace.
 *
 * @param {object} review
 * @returns {boolean}
 */
function isProvisionalPublishDate(review) {
  return !!(review && review.publishDate && PROVISIONAL_DATE_SOURCES.has(review.dateSource));
}

module.exports = {
  PROVISIONAL_DATE_SOURCES,
  NEAR_OPENING_DAYS,
  isNearOpening,
  llmScoringDateFields,
  isPlausibleGuess,
  roundupEntryDateFields,
  isProvisionalPublishDate,
};
