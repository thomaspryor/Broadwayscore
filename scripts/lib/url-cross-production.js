'use strict';
/**
 * URL cross-production ownership decision.
 *
 * When the same review URL is found under two productions of the same title
 * (e.g. a Broadway run and a later West End revival), gather-reviews.js must
 * decide which production legitimately owns it. The only trustworthy signal is
 * the review's own year vs. each production's run.
 *
 * Rule: a production takes ownership ONLY when the review's year is strictly
 * closer to it than to the incumbent. Unknown review year, or an exact tie,
 * returns false → first-writer-wins, no re-homing.
 *
 * History: the previous heuristic awarded the URL to the *more recent*
 * production whenever the review year couldn't be extracted (and on ties).
 * Because publishDate is often enriched AFTER the URL sweep runs, this silently
 * re-homed legitimate older reviews onto newer same-title revivals and flagged
 * the originals wrongProduction — suppressing real reviews from scoring. ≥9
 * confirmed mis-homings (Les Liaisons 2016→2026, Hello Dolly 1995→2017,
 * Shucked 2023→2026, …) traced to this branch. 2026-06-23.
 *
 * BRO-7815 (2026-11-19): 16 more mis-homings survived the year rule, in three
 * shapes, each now closed by an optional input (callers that omit it keep the
 * old behaviour):
 *   - sameTitle === false: the two shows are different titles (EW's Lion King
 *     review went to "13", the FT's Paranormal Activity review to "Alice in
 *     Wonderland"). Year proximity says nothing across titles: never re-home.
 *   - thisRun / existingRun ({ from, to } years): a long run owns the reviews
 *     written while it was playing. A 2018 revisit of Broadway's Beautiful
 *     (2014-2019) is 0 years from that run, not 4 years from its opening, so a
 *     2015 West End transfer cannot claim it.
 *   - existingReviewYear: the incumbent copy's own publishDate. The incoming
 *     copy's date is often wrong (it was dated for the show that found it); when
 *     the incumbent's own date does not also point at this show, keep it.
 *
 * @param {object} p
 * @param {number|null|undefined} p.reviewYear  Year the review was published (incoming copy).
 * @param {number|null|undefined} p.thisYear    Opening year of the production seeking ownership.
 * @param {number|null|undefined} p.existingYear Opening year of the production currently holding the URL.
 * @param {{from:number,to:number}|null} [p.thisRun]     Run window of the seeking production (years).
 * @param {{from:number,to:number}|null} [p.existingRun] Run window of the incumbent production (years).
 * @param {boolean} [p.sameTitle]  false when the two shows are different titles.
 * @param {number|null} [p.existingReviewYear] Year on the incumbent copy's own publishDate.
 * @returns {boolean} true → re-home the URL to `thisYear`'s production.
 */
function shouldTakeUrlOwnership({
  reviewYear, thisYear, existingYear, thisRun, existingRun, sameTitle, existingReviewYear,
} = {}) {
  if (sameTitle === false) return false;
  if (!reviewYear || !thisYear || !existingYear) return false;
  const thisDist = yearDistance(reviewYear, thisYear, thisRun);
  const existingDist = yearDistance(reviewYear, existingYear, existingRun);
  if (!(thisDist < existingDist)) return false;
  if (existingReviewYear && existingReviewYear !== reviewYear) {
    // The incumbent's own date must agree that this show is the closer one.
    if (!(yearDistance(existingReviewYear, thisYear, thisRun)
      < yearDistance(existingReviewYear, existingYear, existingRun))) return false;
  }
  return true;
}

/**
 * Years between a review year and a production: 0 inside its run window,
 * otherwise the gap to the nearer end. Without a usable window, the gap to the
 * opening year (the original rule).
 */
function yearDistance(reviewYear, openYear, run) {
  if (run && Number.isFinite(run.from) && Number.isFinite(run.to) && run.to >= run.from) {
    if (reviewYear < run.from) return run.from - reviewYear;
    if (reviewYear > run.to) return reviewYear - run.to;
    return 0;
  }
  return Math.abs(openYear - reviewYear);
}

/**
 * Rebuild-side twin of the ownership rule: does `other` fit the review year
 * strictly better than `mine`? Run distance first (0 inside the run), then
 * opening-year distance as the tie-break, so the answer is symmetric and a
 * tie in both leaves the call to the caller (no flag).
 *
 * @param {number} reviewYear
 * @param {{openYear:number, run?:{from:number,to:number}|null}} mine
 * @param {{openYear:number, run?:{from:number,to:number}|null}} other
 */
function otherFitsReviewYearBetter(reviewYear, mine, other) {
  if (!reviewYear || !mine || !other || !mine.openYear || !other.openYear) return false;
  const runMine = yearDistance(reviewYear, mine.openYear, mine.run);
  const runOther = yearDistance(reviewYear, other.openYear, other.run);
  if (runOther !== runMine) return runOther < runMine;
  return Math.abs(other.openYear - reviewYear) < Math.abs(mine.openYear - reviewYear);
}

/** First four-digit 19xx/20xx year in a date-ish value, or null. */
function extractYear(v) {
  if (v == null) return null;
  const m = String(v).match(/\b((?:19|20)\d\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Run window in years for a shows.json entry: opening year to closing year.
 * With no closing date, a show that is still playing (status open/previews)
 * runs to `nowYear`; any other show (closed with the date missing, upcoming)
 * is treated as its opening year only, so a missing date never stretches a
 * closed run across later years. null without an opening date.
 */
function showRunYears(show, nowYear = new Date().getUTCFullYear()) {
  if (!show) return null;
  const from = extractYear(show.openingDate);
  if (!from) return null;
  const closing = extractYear(show.closingDate);
  const playing = show.status === 'open' || show.status === 'previews';
  const to = closing || (playing ? Math.max(from, nowYear) : from);
  return { from, to: Math.max(from, to) };
}

/** Title key for "is this the same show": lower-case, no leading article or "Disney's". */
function titleKey(title) {
  return String(title || '').toLowerCase()
    .replace(/[\u2018\u2019']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(?:disneys |the )+/, '')
    .replace(/ (?:the musical|a new musical|the play)$/, '')
    .trim();
}

/**
 * Are two shows.json entries productions of the same title? Exact title key,
 * or one key starting the other ("Kinky Boots" / "Kinky Boots the Musical").
 * Returns null when either title is missing (unknown, not "different").
 */
function sameShowTitle(a, b) {
  const ka = titleKey(a && a.title);
  const kb = titleKey(b && b.title);
  if (!ka || !kb) return null;
  if (ka === kb) return true;
  return ka.startsWith(kb + ' ') || kb.startsWith(ka + ' ');
}

/**
 * Does the copy currently holding a shared URL give it up to another show?
 *
 * Junk (invalid tier, wrongShow, wrong/garbage content, a wrongArticle verdict)
 * always did. BRO-6909 adds a copy its own show has already disowned as another
 * production (wrongProduction, or rejected with reason wrong_production) unless a
 * person cleared or overrode that verdict. Without it, ENO's "Tosca" (London
 * Coliseum, 2026) could not save the FT / Telegraph / Times reviews: the Met's
 * "Tosca" (also 2026) had collected them first and rejected them as wrong
 * production, the years tie, and first-writer-wins kept them there, hidden.
 * The incoming copy still faces its own show's production guards.
 *
 * @param {object|null} existingData the holder's review file
 * @returns {boolean}
 */
function existingCopyYieldsUrl(existingData) {
  const { shouldSkipWrongProductionAudit } = require('./review-guards');
  const d = existingData;
  if (!d || typeof d !== 'object') return false;
  if (d.contentTier === 'invalid'
    || d.wrongShow === true
    || d.incompleteReason === 'wrong_content'
    || d.incompleteReason === 'scraper_garbage'
    || (d.contentVerification && d.contentVerification.wrongArticle === true)) return true;
  const disowned = d.wrongProduction === true || d.rejectionReason === 'wrong_production';
  // A person cleared or overrode the verdict: the copy stays the URL's owner.
  return disowned && !shouldSkipWrongProductionAudit(d);
}

/**
 * BRO-7815 class guard: is a stored "Same URL correctly belongs in <other>"
 * wrongProduction flag contradicted by the file's own evidence?
 *
 * Reasons (any one makes it suspect):
 *   - other-show-missing: the show named in the note is not in shows.json.
 *   - different-title: the other show is a different title, so the URL move was
 *     never a production question.
 *   - own-date-fits-own-run: the file's own publishDate falls inside its own
 *     show's run and outside the other show's run.
 *   - own-date-closer: under the ownership rule, the file's own date points at
 *     its own show, not the other one.
 * A person still reads the text before clearing: publishDate is often wrong
 * (dated for whichever show found it), so this lists candidates, it never clears.
 *
 * @param {object} data      the flagged review file
 * @param {object} ownShow   shows.json entry for data.showId
 * @param {object} otherShow shows.json entry for the show named in the note
 * @param {number} [nowYear]
 * @returns {{ flagged: boolean, otherShowId: string|null, suspect: boolean, reasons: string[] }}
 */
function classifyCrossShowUrlFlag(data, ownShow, otherShow, nowYear) {
  const note = data && typeof data.wrongProductionNote === 'string' ? data.wrongProductionNote : '';
  const m = note.match(/Same URL correctly belongs in (\S+)/);
  const out = { flagged: false, otherShowId: m ? m[1] : null, suspect: false, reasons: [] };
  if (!data || data.wrongProduction !== true || !m) return out;
  out.flagged = true;
  if (!otherShow) out.reasons.push('other-show-missing');
  else if (sameShowTitle(ownShow, otherShow) === false) out.reasons.push('different-title');
  const year = extractYear(data.publishDate);
  const ownRun = showRunYears(ownShow, nowYear);
  const otherRun = showRunYears(otherShow, nowYear);
  if (year && ownRun && otherRun) {
    const inOwn = year >= ownRun.from && year <= ownRun.to;
    const inOther = year >= otherRun.from && year <= otherRun.to;
    if (inOwn && !inOther) out.reasons.push('own-date-fits-own-run');
    else if (yearDistance(year, ownRun.from, ownRun) < yearDistance(year, otherRun.from, otherRun)) {
      out.reasons.push('own-date-closer');
    }
  }
  out.suspect = out.reasons.length > 0;
  return out;
}

module.exports = {
  shouldTakeUrlOwnership,
  existingCopyYieldsUrl,
  yearDistance,
  otherFitsReviewYearBetter,
  extractYear,
  showRunYears,
  sameShowTitle,
  classifyCrossShowUrlFlag,
};
