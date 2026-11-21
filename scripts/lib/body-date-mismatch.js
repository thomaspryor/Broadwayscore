'use strict';
/**
 * BRO-2770: a review-texts body can be replaced IN PLACE with a different
 * article while the metadata that came with the old article (url,
 * publishDate, aggregatorStars, originalScore*, scoreSource, scores) stays.
 *
 * Evidence: the-story-west-end-2026/london-box-office--stuart-king.json held
 * Stuart King's 4 Sept 2026 review of THE STORY (body byline "Stuart King
 * 4 September, 2026") while url pointed at a 2023 A Ghost Story post,
 * publishDate was 2023-05-31 and aggregatorStars '4/5' came from that old
 * page. The date guards flagged it wrongProduction off the stale date
 * ("published 1191d before openingDate"), so the real review never shipped.
 * Clearing the flag alone would have published a fabricated 80 from the old
 * page's stars.
 *
 * Three pieces, all keyed on the byline date in the first 500 chars of the
 * body (extractDateFromText: exactly one date, run/closing dates rejected):
 *   - detectBodyDateMismatch: in-body date vs publishDate, > maxDays apart.
 *     Feeds the corroboration signal in wrong-production-corroboration.js so
 *     the date guards HOLD (route to repair) instead of flagging
 *     wrongProduction, and the corpus audit scripts/audit-body-date-mismatch.js.
 *   - isDifferentDatedArticle: old body and new body carry byline dates more
 *     than maxDays apart, i.e. a different article was written over the file.
 *   - invalidateStaleArticleFields: on such a swap, park the fields that were
 *     carried over from the old article (unchanged by the write), take
 *     publishDate from the new byline and mark the url for repair. Wired into
 *     safeWriteReview (review-write-guard.js), the chokepoint every writer
 *     shares.
 *
 * Pure module: no fs, no process.
 */

// Byline date patterns. Moved here from collect-review-texts.js (which now
// requires it) so the gates, the writer and the audit read one parser.
const TEXT_DATE_PATTERNS = [
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi,
  /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December),?\s+(\d{4})\b/gi,
];
// Same words as before the move (collect-review-texts' publishDate fallback
// must not change). The stricter byline reading adds run-date words below.
const TEXT_DATE_RUN_WORDS = /\b(through|until|closing|effective|expires|ends|extended|running|booking|playing|performances?)\b/i;
const BYLINE_RUN_WORDS = /\b(thru|beginning|begins|starting|opens|opening)\b/i;
const TEXT_DATE_MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/**
 * publishDate from the byline in the first 500 chars of fullText. Only fires
 * when exactly ONE date is found; dates preceded by run/closing words are
 * ignored. Returns 'YYYY-MM-DD' or null.
 */
function extractDateFromText(fullText) {
  if (typeof fullText !== 'string' || !fullText) return null;
  const header = fullText.substring(0, 500);
  const allMatches = [];
  for (const pat of TEXT_DATE_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(header)) !== null) {
      const before = header.substring(Math.max(0, m.index - 50), m.index).toLowerCase();
      if (TEXT_DATE_RUN_WORDS.test(before)) continue;
      allMatches.push(m[0]);
    }
  }
  if (allMatches.length !== 1) return null;

  const match = allMatches[0];
  const m1 = match.match(/^([A-Za-z]+)\s+(\d+)(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  const m2 = match.match(/^(\d+)(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})$/);
  let monthStr, day, year;
  if (m1) { monthStr = m1[1].toLowerCase(); day = parseInt(m1[2], 10); year = parseInt(m1[3], 10); }
  else if (m2) { day = parseInt(m2[1], 10); monthStr = m2[2].toLowerCase(); year = parseInt(m2[3], 10); }
  else return null;

  const month = TEXT_DATE_MONTHS[monthStr];
  if (!month || day < 1 || day > 31 || year < 1970 || year > new Date().getFullYear() + 1) return null;
  const d = new Date(year, month - 1, day);
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Stricter reading for the mismatch checks: the date must look like the
// article's own byline, not a run date, a listing range, an "Updated" stamp or
// a date the prose mentions. A 2026-10-13 corpus scan of extractDateFromText
// against publishDate gave 337 hits, most of them those shapes. Counted only:
//   - a date shortly after a "By" byline ("By: Samuel L. Leiter May 15, 2022"),
//   - a date directly followed by a clock time ("Stuart King 4 September,
//     2026, 08:36"),
// and never one inside a range or after updated/modified/from/until.
// "By" + 1-4 capitalized name words (+ optional weekday) + optional separator
// ("By Jane Doe – March 3, 2026", "Posted by Jane Doe on March 3, 2026").
const BYLINE_BEFORE = /\b[Bb][Yy]:?\s+(?:[A-Z][\w.'’-]*,?\s+){1,5}(?:(?:[\/|–—-]|on)\s*)?$/;
// Clock time straight after the date, no "at" (news-ticker headlines read
// "<headline> October 6, 2026 at 6:04 pm" on the same page chrome).
const BYLINE_TIME_AFTER = /^,?\s*\d{1,2}[:.]\d{2}\b/;
const BYLINE_REJECT_BEFORE = /(?:updated|modified|\b(?:from|until|through|thru|to|since|on)|[-–—])\s*[:,]?\s*(?:[A-Za-z]+day,?\s*)?$/i;
// After a "By <name>" byline a dash or "on" is the byline's own separator;
// only the run/update words still disqualify the date.
const BYLINE_REJECT_BEFORE_AFTER_NAME = /(?:(?:updated|modified)(?:\s+on)?|\b(?:from|until|through|thru|to|since))\s*[:,]?\s*(?:[-–—]\s*)?(?:[A-Za-z]+day,?\s*)?$/i;
// A capitalized "On" opens a sentence ("By Logan Martell On December 2, 2025,
// the Met delivered..."): the date it introduces is the performance, not the byline.
const SENTENCE_ON_BEFORE = /\bOn\s+(?:[A-Z][a-z]+day,?\s*)?$/;
// A date followed by a colon or full stop introduces text ("By David Sheward
// January 22, 2025: Billed as...", "By Samuel L. Leiter April 6, 2025. The
// big reason..."): Theater Life stamps the performance seen that way, days
// before publication.
const BYLINE_REJECT_AFTER = /^\s*(?:[-–—]|to\b|until\b|[:.](?!\d))/i;

/**
 * The article's own byline date in the first 500 chars of fullText, or null.
 * Exactly one qualifying date is required. A date after `notAfter` (the day the
 * text was fetched; default tomorrow) is a typo on the page, never the byline.
 */
function extractBylineDate(fullText, { notAfter = null } = {}) {
  if (typeof fullText !== 'string' || !fullText) return null;
  const header = fullText.substring(0, 500);
  const found = [];
  for (const pat of TEXT_DATE_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(header)) !== null) {
      const before = header.substring(Math.max(0, m.index - 80), m.index);
      const after = header.substring(m.index + m[0].length, m.index + m[0].length + 20);
      if (TEXT_DATE_RUN_WORDS.test(before.slice(-50)) || BYLINE_RUN_WORDS.test(before.slice(-50))) continue;
      const afterName = BYLINE_BEFORE.test(before);
      const rejectBefore = afterName ? BYLINE_REJECT_BEFORE_AFTER_NAME : BYLINE_REJECT_BEFORE;
      if (rejectBefore.test(before.slice(-25)) || BYLINE_REJECT_AFTER.test(after)) continue;
      if (afterName && SENTENCE_ON_BEFORE.test(before)) continue;
      if (!afterName && !BYLINE_TIME_AFTER.test(after)) continue;
      found.push(m[0]);
    }
  }
  if (found.length !== 1) return null;
  const date = extractDateFromText(found[0]);
  // "October 26, 2026" on a review fetched that August: a typo, and it stays
  // one after October 26, so the bound is the fetch day, not the clock.
  const limit = _isoDay(notAfter) || new Date(Date.now() + DAY_MS).toISOString().slice(0, 10);
  if (date && date > limit) return null;
  return date;
}

const DEFAULT_MAX_DAYS = 3;
const DAY_MS = 86400000;

function _isoDay(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  const t = Date.parse(m[1] + 'T00:00:00Z');
  return Number.isNaN(t) ? null : m[1];
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/**
 * In-body byline date vs the record's publishDate.
 * @returns {{bodyDate: string, publishDate: string, deltaDays: number}|null}
 *   deltaDays = bodyDate - publishDate (positive: body is later). null when
 *   either date is missing or they agree within maxDays.
 */
function detectBodyDateMismatch(review, { maxDays = DEFAULT_MAX_DAYS } = {}) {
  if (!review || typeof review.fullText !== 'string' || review.fullText.length <= 100) return null;
  const publishDate = _isoDay(review.publishDate);
  if (!publishDate) return null;
  // The text can't be dated after it was fetched: bound by the latest fetch
  // stamp plus a day (a UK byline fetched at 23:00Z the evening before). A
  // stamp older than publishDate was left behind by a later text write, so it
  // bounds nothing (the default, tomorrow, applies).
  const fetched = [review.textFetchedAt, review.firstSeenAt].map(_isoDay).filter(Boolean).sort().pop() || null;
  const notAfter = fetched && fetched >= publishDate
    ? new Date(Date.parse(fetched + 'T00:00:00Z') + DAY_MS).toISOString().slice(0, 10)
    : null;
  const bodyDate = extractBylineDate(review.fullText, { notAfter });
  if (!bodyDate) return null;
  const deltaDays = daysBetween(publishDate, bodyDate);
  if (Math.abs(deltaDays) <= maxDays) return null;
  return { bodyDate, publishDate, deltaDays };
}

/**
 * True when both bodies carry a byline date and those dates are more than
 * maxDays apart: the write put a different article over the old one.
 * With `recordDate` (the record's publishDate), a new body whose byline
 * agrees with it is the right article replacing a stray one: the record's
 * metadata already describes the new body, so nothing is stale.
 */
function isDifferentDatedArticle(oldText, newText, { maxDays = DEFAULT_MAX_DAYS, recordDate = null } = {}) {
  if (typeof oldText !== 'string' || typeof newText !== 'string' || oldText === newText) return null;
  const oldBodyDate = extractBylineDate(oldText);
  const newBodyDate = extractBylineDate(newText);
  if (!oldBodyDate || !newBodyDate) return null;
  if (Math.abs(daysBetween(oldBodyDate, newBodyDate)) <= maxDays) return null;
  // publishDate is often prose ("March 25th, 2018"): read it as a date too.
  const record = _isoDay(recordDate) || (typeof recordDate === 'string' ? extractDateFromText(recordDate) : null);
  if (record && Math.abs(daysBetween(record, newBodyDate)) <= maxDays) return null;
  return { oldBodyDate, newBodyDate };
}

// Fields that describe the OLD article: its date, its page's star rating and
// the scores computed from either. A subset of url-change-invariant.js's
// URL_DERIVED_FIELDS (the url did not move here, so text/excerpt fields the
// write refreshed are left alone).
const STALE_ARTICLE_DATE_FIELDS = ['publishDate', 'publishDateVerified', 'publishDateSource', 'dateSource'];
const STALE_ARTICLE_SCORE_FIELDS = [
  'aggregatorStars', 'aggregatorStarsSource',
  'originalScore', 'originalScoreSource', 'originalScoreNormalized', 'originalScoreType',
  'originalRating', 'originalScoreCapturedFrom', 'scoreSource',
  'llmScore', 'llmMetadata', 'ensembleData', 'assignedScore', 'bucket', 'llmConfidence',
];
const STALE_ARTICLE_FIELDS = [...STALE_ARTICLE_DATE_FIELDS, ...STALE_ARTICLE_SCORE_FIELDS];

function _same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Mutates `newData` after a body swap: every STALE_ARTICLE_FIELDS value the
 * write carried over unchanged from `existing` is parked under
 * staleArticleFieldsParked and removed, publishDate is re-derived from the new
 * byline, and the url is marked for repair (it still names the old article).
 * Human-verified values are cleared too: they were checked against the old
 * article.
 *
 * @param {object} newData  record about to be written (mutated)
 * @param {object} existing record on disk before this write
 * @param {{oldBodyDate: string, newBodyDate: string}} swap  isDifferentDatedArticle() result
 * @param {{now?: string}} [opts]
 * @returns {string[]} names of the fields cleared
 */
function invalidateStaleArticleFields(newData, existing, swap, opts = {}) {
  if (!newData || !existing || !swap) return [];
  const now = opts.now || new Date().toISOString();
  // A human-verified rating is not kept either: it was checked against the
  // page at this url, i.e. the OLD article, so it does not score the new body.
  const parked = {};
  const cleared = [];
  for (const field of STALE_ARTICLE_FIELDS) {
    if (existing[field] === undefined || existing[field] === null) continue;
    if (!_same(newData[field], existing[field])) continue; // the write refreshed it
    parked[field] = existing[field];
    delete newData[field];
    cleared.push(field);
  }
  if (cleared.includes('publishDate') || !newData.publishDate) {
    newData.publishDate = swap.newBodyDate;
    newData.dateSource = 'text-regex-body-swap';
  }
  newData.bodySwapDetected = {
    oldBodyDate: swap.oldBodyDate,
    newBodyDate: swap.newBodyDate,
    url: newData.url || null,
    detectedAt: now,
    cleared,
  };
  if (cleared.length) {
    newData.staleArticleFieldsParked = { ...parked, parkedAt: now };
  }
  // The url still points at the old article; repair finds the real one.
  newData.needsUrlRepair = true;
  newData.needsUrlRepairReason = `body replaced in place: byline ${swap.newBodyDate} vs previous body ${swap.oldBodyDate}; url not updated`;
  return cleared;
}

/**
 * A body swap whose url still names the old article. Cleared implicitly when
 * the url changes (a url repair, or a re-ingest at the right url).
 * audit-body-date-mismatch.js lists these every day until they are repaired.
 */
function isUrlRepairPending(data) {
  if (!data || data.needsUrlRepair !== true || !data.bodySwapDetected) return false;
  const was = data.bodySwapDetected.url || null;
  const now = data.url || null;
  if (!was || !now) return was === now;
  // A cosmetic rewrite (trailing slash, http->https) is not a repair.
  return !require('./url-change-invariant').urlCanonicallyChanged(was, now);
}

/**
 * Push-time restore support (review-write-guard.js _differentArticleAtSamePath):
 * the local record recorded a body swap for exactly this body, so the
 * committed copy's values for STALE_ARTICLE_FIELDS belong to the old article.
 */
function bodySwapClearsField(field, localData, committedData) {
  const bs = localData && localData.bodySwapDetected;
  if (!bs || !Array.isArray(bs.cleared) || !bs.cleared.includes(field)) return false;
  if (!committedData || committedData.fullText === localData.fullText) return false;
  // Only while the committed copy still holds the OLD article: a committed
  // re-collection of the new article carries legitimate values to restore.
  return extractBylineDate(localData.fullText) === bs.newBodyDate
    && extractBylineDate(committedData.fullText) === bs.oldBodyDate;
}

module.exports = {
  DEFAULT_MAX_DAYS,
  STALE_ARTICLE_FIELDS,
  extractDateFromText,
  extractBylineDate,
  detectBodyDateMismatch,
  isDifferentDatedArticle,
  invalidateStaleArticleFields,
  isUrlRepairPending,
  bodySwapClearsField,
};
