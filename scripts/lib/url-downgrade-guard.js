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

function _urlPathDate(url) {
  if (!url) return null;
  const r = extractDateFromUrl(url);
  if (!r || !r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return null;
  const d = new Date(r.date);
  return isNaN(d.getTime()) ? null : d;
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
  if (!show || !newUrl) return { regression: false, reason: null };
  if (!earliestShowDate(show)) return { regression: false, reason: null };

  const newDate = _urlPathDate(newUrl);
  if (!newDate) return { regression: false, reason: null };

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
