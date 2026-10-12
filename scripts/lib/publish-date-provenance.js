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
      return isNearOpening(show, now)
        ? { llmPublishDateGuess: d, publishDate: d, dateSource: 'llm-scoring' }
        : { llmPublishDateGuess: d };
    }
  }
  return {};
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
  roundupEntryDateFields,
  isProvisionalPublishDate,
};
