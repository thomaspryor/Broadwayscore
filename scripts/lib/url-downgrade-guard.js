/**
 * URL-swap regression guard (task #1416).
 *
 * maybeUpgradeUrl() (review-normalization.js) replaces a review file's url
 * when the current content is bad (missing/truncated fullText) and the
 * candidate shares a distinctive slug token with the show — but "shares a
 * token" only rules out a DIFFERENT SHOW, not a different PRODUCTION of the
 * SAME show. On a much-revived title (Equus, Romeo and Juliet, Cats), an
 * aggregator's "better" URL can point at a prior production's article; the
 * swap then discards a genuinely correct current-run URL for a wrong one and
 * clears wrongProduction/publishDate along the way (url-change-invariant.js
 * force:true), so nothing downstream catches it until content lands and a
 * date-guard rebuild re-flags it days later — which #483's drain then reads
 * as a stale flag and clears again. Verified on 8/8 corpus matches
 * (equus-west-end-2026, romeo-and-juliet, cats-the-jellicle-ball, nysr,
 * mexodus — all real-2026-url → prior-production-url swaps), see
 * ~/Documents/claude-outputs/handoff-483-predicate-narrowing-2026-08-14.md.
 *
 * Fix: before adopting a candidate URL as an "upgrade", check whether the
 * candidate's OWN url-path date (the same url-date fallback
 * rebuild-all-reviews.js and flag-wrong-production-by-date.js already use)
 * falls outside the show's current-run window. A genuine upgrade for the
 * CURRENT production can never be dated outside that window; a URL that is
 * clearly dated outside it is evidence of a wrong-production swap, not a
 * content upgrade, and must be refused.
 *
 * Fails open (regression: false) whenever there isn't enough signal to
 * judge — no show record, no show window, or no date extractable from the
 * candidate URL — matching every other date guard in this codebase.
 */

'use strict';

const { extractDateFromUrl } = require('./rebuild-helpers');
const { evaluateDateGuard, earliestShowDate } = require('./date-guard');
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');
const { isForumThreadUrl } = require('./talkinbroadway-forum-link');

function _urlPathDate(url) {
  if (!url) return null;
  const r = extractDateFromUrl(url);
  if (!r || !r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  const d = new Date(r.date);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * A /YYYY/MM/ url path gives extractDateFromUrl only a year (no day), so
 * _urlPathDate() returns null and the date guard never ran: on 2026-10-11 a
 * 2026 tour's Deadline stub was swapped to a /2024/03/ review of the 2024
 * Broadway production, clearing its wrongProduction flag. When the WHOLE year
 * precedes the show's earliest date the article cannot be about the current
 * run. Only the "year before the window" direction is judged: a year-only url
 * inside or after the window stays open (fails open, like every date guard).
 * A declared prior run / tour leg touching that year is legitimate coverage.
 */
function _yearOnlyRegression(url, show) {
  const r = extractDateFromUrl(url);
  const year = r && r.yearOnly;
  const earliest = earliestShowDate(show);
  if (!Number.isInteger(year) || !earliest) return { regression: false, reason: null };
  const showYear = parseInt(String(earliest).slice(0, 4), 10);
  if (!(year < showYear)) return { regression: false, reason: null };
  // Any declared prior run / tour leg overlapping that calendar year is
  // legitimate coverage. Overlap on the declared dates, not on the year's
  // endpoints: a Mar-Aug run contains neither Jan 1 nor Dec 31.
  const yearOf = (s) => parseInt(String(s || '').slice(0, 4), 10);
  const touchesYear = (start, end) => {
    const a = yearOf(start);
    if (!Number.isInteger(a)) return false;
    const b = end ? yearOf(end) : Infinity; // no close date = still running
    return a <= year && year <= (Number.isInteger(b) ? b : Infinity);
  };
  const runs = Array.isArray(show.priorRuns) ? show.priorRuns : [];
  const legs = Array.isArray(show.tourLegs) ? show.tourLegs : [];
  if (runs.some(r => r && touchesYear(r.openingDate, r.closingDate))
    || legs.some(l => l && touchesYear(l.startDate, l.endDate))) {
    return { regression: false, reason: null };
  }
  return {
    regression: true,
    reason: `candidate url path year ${year} precedes the show's first date ${earliest} — refusing swap`,
    urlDate: String(year),
    issue: 'year-before-window',
  };
}

/**
 * Is swapping a review's url to `newUrl` a regression — a candidate whose
 * own url-path date is clearly outside the show's current-production window?
 *
 * @param {object} args
 * @param {string} args.newUrl - the candidate replacement URL
 * @param {object} args.show - show record (previewDate/previewsStartDate/
 *   openingDate/closingDate/category/market/priorRuns/tourLegs)
 * @param {string} [args.outletId] - for the UK-trusted-outlet grace window
 * @returns {{ regression: boolean, reason: string|null, urlDate?: string, issue?: string, diffDays?: number }}
 */
function isUrlSwapRegression({ newUrl, show, outletId } = {}) {
  // A Talkin' Broadway forum announcement thread (allthatchat_new/d.php) is a
  // teaser + "Link" anchor, never the review. Good Time Charlie lost its real
  // /page/ob/ review page to one of these via maybeUpgradeUrl and then sat as an
  // empty stub that no re-fetch of the thread URL could ever fill.
  if (newUrl && isForumThreadUrl(newUrl)) {
    return {
      regression: true,
      reason: 'candidate url is a Talkin\' Broadway forum announcement thread, not a review page — refusing swap',
      issue: 'forum-thread-url',
    };
  }
  if (!show || !newUrl) return { regression: false, reason: null };
  if (!earliestShowDate(show)) return { regression: false, reason: null };

  const newDate = _urlPathDate(newUrl);
  if (!newDate) return _yearOnlyRegression(newUrl, show);

  const decision = evaluateDateGuard({ pubDate: newDate, show, outletId });
  if (!decision.flag) return { regression: false, reason: null };

  // A declared prior run / tour leg is legitimate coverage, not contamination.
  if (isWithinPriorRun(newDate, show.priorRuns)) return { regression: false, reason: null };
  if (isWithinTourLeg(newDate, show.tourLegs)) return { regression: false, reason: null };

  const urlDate = newDate.toISOString().slice(0, 10);
  return {
    regression: true,
    reason: `candidate url dated ${urlDate} (${decision.issue}, ${decision.diffDays}d outside window) — refusing swap`,
    urlDate,
    issue: decision.issue,
    diffDays: decision.diffDays,
  };
}

module.exports = { isUrlSwapRegression };
