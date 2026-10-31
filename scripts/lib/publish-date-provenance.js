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

/**
 * dateSource values that say the date was read from the review's own page (or
 * set by a person). These are never replaced by a later fetch, and they are
 * trusted by the opening-window recheck.
 */
const PAGE_DATE_SOURCE = /^(?:html-|extracted-from-html|page-|article-byline|human-|manual)/;

/** dateSource names that say the date came from an aggregator, roundup, feed or search result. */
const CARRIED_DATE_SOURCE = /(aggregator|roundup|rss|feed|serp|google-news|search|dtli|show-?score|bww|broadwayworld|playbill|nyc-?theatre|stagedoor|westendtheatre|theatre-reviews|lbo|listing|llm)/i;

/**
 * dateSource values for a date read from an ARCHIVED copy of the page
 * (archive.org / archive.today). The copy is the same article, but a snapshot
 * can be a later edit or a listing that replaced it, so a live-page date may
 * still replace it and it is not trusted by the opening-window recheck.
 */
const ARCHIVE_PAGE_DATE_SOURCE = /^html-archive/;

/** True when dateSource says the date was read from the review's own live page or set by a person. */
function isPageDateSource(dateSource) {
  return typeof dateSource === 'string' && PAGE_DATE_SOURCE.test(dateSource) && !ARCHIVE_PAGE_DATE_SOURCE.test(dateSource);
}

/** The dateSource to store for a date read from fetched HTML: 'html-archive' when the HTML came from an archive. */
function htmlDateSourceFor(fetchMethod) {
  return /archive/i.test(String(fetchMethod || '')) ? 'html-archive' : 'html-page';
}

/** A page date this many days away from a stored carried date is not trusted on its own. */
const MAX_PAGE_DATE_DIVERGENCE_DAYS = 7;

/**
 * May a date read from the page replace the stored (carried) date? BRO-5674.
 * isReplaceableByPageDate holds for most of the corpus (40,903 of 47,855 dated
 * files), so one misread dateline must not move a date by weeks: a page date
 * more than MAX_PAGE_DATE_DIVERGENCE_DAYS from the stored date is kept as
 * `pageDateCandidate` and the file is marked needsDateRecheck instead.
 * `allowDivergent` is for the recheck sweep, whose stored date is already in
 * doubt (needsOpeningWindowDateRecheck).
 *
 * @param {{storedDate?: string|null, pageDate: string, allowDivergent?: boolean}} args
 * @returns {{replace: boolean, divergentDays: number|null}}
 */
function resolvePageDateReplacement({ storedDate, pageDate, allowDivergent = false } = {}) {
  if (typeof pageDate !== 'string' || !YMD.test(pageDate)) return { replace: false, divergentDays: null };
  if (typeof storedDate !== 'string' || !YMD.test(storedDate.slice(0, 10))) return { replace: true, divergentDays: null };
  const days = Math.abs(Date.parse(`${pageDate}T00:00:00Z`) - Date.parse(`${storedDate.slice(0, 10)}T00:00:00Z`)) / 864e5;
  if (days <= MAX_PAGE_DATE_DIVERGENCE_DAYS || allowDivergent) return { replace: true, divergentDays: days };
  return { replace: false, divergentDays: days };
}

/**
 * True when the stored publishDate may be replaced by a date read from the
 * review's own page (dateSource 'html-page'). BRO-5674.
 *
 * Covers the provisional sources (isProvisionalPublishDate) plus every date
 * carried in by an aggregator, roundup, RSS feed or SERP. Those paths
 * (opening-night-poller.js, gather-reviews.js) mostly wrote publishDate with NO
 * dateSource at all, so an unmarked date counts as carried. Other Desert
 * Cities (2026): Theatrely stored 2026-10-16 (no dateSource), the page reads
 * "October 19, 2026 12:00 AM".
 *
 * Never true for a page or human date (isPageDateSource): a page date is not
 * downgraded. Dates from a URL path or the body text ('url*', 'text-regex')
 * keep their old rule: they are filled only when the page gave nothing.
 *
 * @param {object} review
 * @returns {boolean}
 */
function isReplaceableByPageDate(review) {
  if (!review || !review.publishDate) return false;
  if (isProvisionalPublishDate(review)) return true;
  const src = review.dateSource;
  if (src == null || src === '') return true;
  if (typeof src === 'string' && ARCHIVE_PAGE_DATE_SOURCE.test(src)) return true; // a live page outranks a snapshot
  if (isPageDateSource(src)) return false;
  return CARRIED_DATE_SOURCE.test(String(src));
}

/** A review dated more than this many days before opening night needs its page date. */
const OPENING_WINDOW_GRACE_DAYS = 2;

/**
 * Should this review's publishDate be re-read from its page (needsDateRecheck)?
 * True when the show has an openingDate, the stored date is more than
 * OPENING_WINDOW_GRACE_DAYS before it, and the date was not read from the
 * review's own page or set by a person. BRO-5674.
 *
 * The production guards (date-plausibility.js, 180 days; date-guard.js) look
 * for another production's review, so a current-run review mis-dated by a few
 * days to a few months passed them. Corpus sweep 2026-10-19 (shows opening
 * 2025-2026): 201 included reviews dated more than 2 days before opening, some
 * real preview coverage. A page date ('html-page' and the other page sources)
 * is trusted, so real preview coverage stops being marked once read.
 *
 * Not marked: a human-confirmed early post (humanReviewedEarlyPublish), and a
 * date inside one of the show's declared prior runs (inherited reviews).
 *
 * @param {object} review - review file (publishDate, dateSource)
 * @param {object} show - shows.json record (openingDate, priorRuns)
 * @returns {boolean}
 */
function needsOpeningWindowDateRecheck(review, show) {
  if (!review || !show) return false;
  const pd = typeof review.publishDate === 'string' ? review.publishDate.slice(0, 10) : '';
  const od = typeof show.openingDate === 'string' ? show.openingDate.slice(0, 10) : '';
  if (!YMD.test(pd) || !YMD.test(od)) return false;
  if (isPageDateSource(review.dateSource)) return false;
  if (review.humanReviewedEarlyPublish === true) return false;
  const t = Date.parse(`${pd}T00:00:00Z`);
  const o = Date.parse(`${od}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(o)) return false;
  if (t >= o - OPENING_WINDOW_GRACE_DAYS * 864e5) return false;
  if (Array.isArray(show.priorRuns) && show.priorRuns.length) {
    const { isWithinPriorRun } = require('./wrong-production-autoclear');
    if (isWithinPriorRun(pd, show.priorRuns)) return false;
  }
  return true;
}

/**
 * Whether the recheck sweep (backfill-review-dates --recheck-dates) and its audit should pick this file (BRO-5769).
 * The live predicate decides. The sticky needsDateRecheck flag alone no longer selects a file: it outlives the
 * condition that set it (collect-review-texts.js is the only other clearer), so a stale flag re-fetched pages whose
 * date the predicate no longer flags and parked them as pageDateCandidate. The flag still counts when a
 * pageDateCandidate exists, because that file holds a page date awaiting a decision.
 * @param {object} review
 * @param {object} show - shows.json record
 * @returns {boolean}
 */
function isDateRecheckCandidate(review, show) {
  if (!review) return false;
  if (needsOpeningWindowDateRecheck(review, show)) return true;
  return review.needsDateRecheck === true && !!review.pageDateCandidate;
}

/**
 * The text-fetch fallback for a review whose page gave no meta/JSON-LD date
 * (BRO-5351). A date parsed out of the URL is never stored as publishDate
 * (CLAUDE.md rule 3: never extract metadata from URLs). The review's own
 * byline date is stored instead, as dateSource 'text-regex'.
 *
 * The URL date may only veto: when the byline date disagrees with it, nothing
 * is stored. A single byline match can be a run or event date, and a compact
 * URL number can be an article id (BRO-4252), so neither wins on its own. The
 * file stays dateless and the rebuild's resolveBackfillPublishDate (which
 * settles exactly that conflict) decides the derived reviews.json date, the
 * same outcome the rebuild produced for every dateless file before this change.
 *
 * @param {object} args
 * @param {string|null} args.textDate - byline date from the body (extractDateFromText), YYYY-MM-DD
 * @param {{date?: string|null}|null} args.urlDate - extractDateFromUrl result (veto only)
 * @returns {{ publishDate: string, dateSource: 'text-regex' } | { publishDate: null, reason: 'no-body-date'|'body-url-conflict' }}
 */
function bodyPublishDateFallback({ textDate, urlDate } = {}) {
  if (typeof textDate !== 'string' || !YMD.test(textDate)) return { publishDate: null, reason: 'no-body-date' };
  const fromUrl = urlDate && typeof urlDate.date === 'string' && YMD.test(urlDate.date) ? urlDate.date : null;
  if (fromUrl && fromUrl !== textDate) return { publishDate: null, reason: 'body-url-conflict' };
  return { publishDate: textDate, dateSource: 'text-regex' };
}

/**
 * The date the ingest anticipatory gate judges on (BRO-5351). A URL date is
 * never stored, but with no stored publishDate the gate still uses the same
 * full YYYY-MM-DD the rebuild recheck resolves (resolveGuardReviewDate), so the
 * two cannot flip a flag back and forth. A URL date the byline vetoed is not
 * used: neither date wins on its own.
 * @param {object} data - review record
 * @param {{bylineVetoed?: boolean}} [opts]
 * @returns {string|null}
 */
function ingestGateDate(data, { bylineVetoed = false } = {}) {
  if (data && data.publishDate) return data.publishDate;
  if (bylineVetoed || !data || !data.url) return null;
  const { resolveBackfillPublishDate } = require('./backfill-publish-date');
  const r = resolveBackfillPublishDate(data);
  return r && /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : null;
}

module.exports = {
  bodyPublishDateFallback,
  ingestGateDate,
  PROVISIONAL_DATE_SOURCES,
  NEAR_OPENING_DAYS,
  isNearOpening,
  llmScoringDateFields,
  isPlausibleGuess,
  roundupEntryDateFields,
  isProvisionalPublishDate,
  isPageDateSource,
  htmlDateSourceFor,
  MAX_PAGE_DATE_DIVERGENCE_DAYS,
  resolvePageDateReplacement,
  isReplaceableByPageDate,
  OPENING_WINDOW_GRACE_DAYS,
  needsOpeningWindowDateRecheck,
  isDateRecheckCandidate,
};
