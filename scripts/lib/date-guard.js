/**
 * Pure decision function for the publish-date wrongProduction guard.
 *
 * Extracted from scripts/flag-wrong-production-by-date.js (2026-05-25) so the
 * guard's behavior — especially the UK-trusted-critic grace-period override —
 * can be unit-tested without I/O. Per project rule 15: test the real function.
 *
 * @param {object} args
 * @param {Date} args.pubDate - parsed publish date of the review
 * @param {object} args.show - the show record (uses previewDate / previewsStartDate / openingDate, closingDate, category/market)
 * @param {string|null} args.outletId - outletId on the review
 * @param {Array|null|undefined} [args.priorRuns] - show.priorRuns; a pubDate covered by a
 *   declared prior run is legitimate earlier-run coverage and is never flagged here
 * @param {Array|null|undefined} [args.tourLegs] - show.tourLegs; a pubDate covered by a
 *   declared tour leg is legitimate current-production coverage and is never flagged here
 * @returns {{ flag: boolean, issue: 'before_preview'|'after_close'|null, diffDays: number, daysAllowedBefore: number }}
 */
const { isWithinPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');

// Exported so the calling script can use the same constants in log messages
// without drift. See scripts/flag-wrong-production-by-date.js.
const DAYS_BEFORE_PREVIEW = 21;
const DAYS_AFTER_CLOSE = 7;
const UK_DAYS_BEFORE_PREVIEW = 35;

// Inclusion-time pre-window thresholds (rebuild-all-reviews.js + scoring-delta.js
// sim — parity by construction, both call evaluatePreWindowInclusion below).
// PRE_WINDOW_DAYS: off-Broadway / London markets, and the rebuild file-flagging
// pass for all categories. Tightened 90→60 (card 386637c5): no legitimate review
// publishes >60d before the earliest show date, and the standalone 21d/35d
// flagger above stays the fine-grained layer.
// PRE_WINDOW_DAYS_BROADWAY: Broadway embargo grace, unchanged.
const PRE_WINDOW_DAYS = 60;
const PRE_WINDOW_DAYS_BROADWAY = 14;

/**
 * Earliest plausible start of a production's run — the window anchor for the
 * pre-opening/date guard. Returns the MIN (not first-non-null) of previewDate /
 * previewsStartDate / openingDate so an out-of-order date (e.g. a stale
 * previewsStartDate recorded AFTER openingDate) can never push the window start
 * later than opening and mis-flag a genuine review filed around opening.
 * Defends against the inverted-date data bug surfaced 2026-06-17 (Three Houses:
 * previewsStartDate 2024-12-04 vs openingDate 2024-05-22). Pure; returns a
 * YYYY-MM-DD string or null.
 */
function earliestShowDate(show) {
  if (!show) return null;
  const cands = [show.previewDate, show.previewsStartDate, show.openingDate]
    .filter(Boolean)
    .map(String);
  if (cands.length === 0) return null;
  return cands.reduce((min, d) => (d < min ? d : min));
}

function evaluateDateGuard({ pubDate, show, outletId, priorRuns, tourLegs }) {
  // NOTE: 'observer' deliberately excluded. observer.com is flagged
  // isDualMarket:true in outlet-registry.json — both NY Observer (US/Broadway
  // critics like David Cote) and The Observer UK share the outletId. Giving
  // them a 35d UK grace on WE shows would widen the wrongProduction window
  // in the wrong direction for the US-side reviews. Dual-market routing
  // handles them separately.
  const UK_TRUSTED_OUTLETS = new Set([
    'thestage', 'financialtimes', 'guardian', 'times-uk', 'telegraph',
    'standard', 'bbc', 'whatsonstage', 'independent',
  ]);
  const UK_MARKETS = new Set(['west-end', 'off-west-end']);

  const earliestStr = earliestShowDate(show);
  if (!earliestStr) return { flag: false, issue: null, diffDays: 0, daysAllowedBefore: DAYS_BEFORE_PREVIEW };

  const isUkMarket = UK_MARKETS.has(show.category) || UK_MARKETS.has(show.market);
  const isUkTrustedOutlet = outletId && UK_TRUSTED_OUTLETS.has(String(outletId).toLowerCase());
  const daysAllowedBefore = (isUkMarket && isUkTrustedOutlet) ? UK_DAYS_BEFORE_PREVIEW : DAYS_BEFORE_PREVIEW;

  const windowStart = new Date(earliestStr);
  windowStart.setDate(windowStart.getDate() - daysAllowedBefore);

  let windowEnd = null;
  if (show.closingDate) {
    windowEnd = new Date(show.closingDate);
    windowEnd.setDate(windowEnd.getDate() + DAYS_AFTER_CLOSE);
  }

  if (pubDate < windowStart) {
    // Production-continuity exemption: pubDate falls inside a declared
    // priorRuns/tourLegs window — legitimate coverage of an earlier run (or
    // tour stop) of THIS production, not a different one. Baked into the
    // pure decision function itself (rather than left to each caller to
    // remember) so no guard built on top of evaluateDateGuard can forget it
    // (BRO-222: the rebuild's reverse cross-market guard was exactly that
    // kind of forgotten caller).
    if (isWithinPriorRun(pubDate, priorRuns) || isWithinTourLeg(pubDate, tourLegs)) {
      return { flag: false, issue: null, diffDays: 0, daysAllowedBefore };
    }
    return {
      flag: true,
      issue: 'before_preview',
      diffDays: Math.round((windowStart - pubDate) / 86400000),
      daysAllowedBefore,
    };
  }
  if (windowEnd && pubDate > windowEnd) {
    if (isWithinPriorRun(pubDate, priorRuns) || isWithinTourLeg(pubDate, tourLegs)) {
      return { flag: false, issue: null, diffDays: 0, daysAllowedBefore };
    }
    return {
      flag: true,
      issue: 'after_close',
      diffDays: Math.round((pubDate - windowEnd) / 86400000),
      daysAllowedBefore,
    };
  }
  return { flag: false, issue: null, diffDays: 0, daysAllowedBefore };
}

/**
 * Pure decision for the dateless-revival wrongProduction guard.
 *
 * The dated date guards (above) only fire when a review HAS a publishDate; a
 * review with NO date escapes them entirely and defaults to includable. On a
 * much-produced title (Glengarry, Equus, War Horse), prior-production reviews
 * get mis-linked to the current production's dir by title-matching aggregators,
 * and the ones lacking a parsed date then score — polluting a fresh revival
 * with old coverage (Glengarry WE 2026 showed 2017 Playhouse reviews).
 *
 * SCOPE — pre-opening only. This guard fires ONLY while the current production
 * has NOT yet opened (opening date today-or-future, or status previews/
 * upcoming). The reason is correctness, not caution: before a production opens,
 * critics have not filed for it, so EVERY dateless review on a revival title is
 * necessarily mis-linked prior-production coverage. The instant a flag is
 * written it persists (the rebuild skips already-flagged files), so the hold
 * survives the previews→open flip; it only releases when a usable date or human
 * override arrives (see shouldAutoClearDatelessRevival).
 *
 * We deliberately do NOT fire post-opening. Once a show is open, genuine
 * reviews that merely failed date-parsing coexist with contamination, and a
 * date-only signal cannot separate them — e.g. Joe Turner's WSJ + Culture Sauce
 * reviews are dateless but real. A blunt post-opening hold would drop those
 * (verified 2026-06-17: 4/4 Joe Turner and 3/3 R&J dateless reviews were
 * genuine current-production coverage). Post-opening contamination is left to
 * the dated guards + content verification + URL-year cross-production guard.
 *
 * CV/LLM cannot be trusted to rescue here even pre-opening — the verifier
 * false-negatives same-title prior productions as valid/high-confidence
 * (cannot tell 2017 Glengarry from 2026 Glengarry from text alone), so the only
 * reliable rescue is a real in-window date or an explicit human clear.
 *
 * @param {object} args
 * @param {boolean} args.hasUsableDate - true if the review has any usable date
 *   (parsed publishDate OR a YYYYMMDD URL date). When true the dated guard owns
 *   the decision and this guard abstains.
 * @param {boolean} args.isMultiProductionTitle - true if the show's title has
 *   ≥2 productions in the dataset (a revival where mis-linking is possible).
 * @param {{ openingDate?: string, previewsStartDate?: string, status?: string }} args.show
 * @param {Date|string|null} [args.now] - reference "now" (defaults to current time)
 * @returns {{ flag: boolean, reason: string|null }}
 */
function evaluateDatelessRevivalGuard({ hasUsableDate, isMultiProductionTitle, show, now }) {
  if (hasUsableDate) return { flag: false, reason: null };
  if (!isMultiProductionTitle) return { flag: false, reason: null };
  if (!show) return { flag: false, reason: null };

  const ref = now ? new Date(now) : new Date();
  if (isNaN(ref.getTime())) return { flag: false, reason: null };

  const opening = show.openingDate ? new Date(show.openingDate) : null;
  const openingValid = opening && !isNaN(opening.getTime());

  // "Not yet opened": opening date is today-or-future, OR (no opening date and
  // the show is not already open/closed), OR the show is still in previews/
  // upcoming. Anything that has demonstrably opened (a past openingDate, or
  // status open/closed) is OUT — post-opening we never blanket-hold.
  const isUpcomingStatus = show.status === 'previews' || show.status === 'upcoming';
  const notYetOpened = openingValid
    ? opening.getTime() >= ref.getTime()
    : (show.status !== 'open' && show.status !== 'closed');

  if (!isUpcomingStatus && !notYetOpened) return { flag: false, reason: null };

  return { flag: true, reason: 'dateless_pre_opening_revival' };
}

/**
 * True when an externally-fetched article's publication date falls outside THIS
 * production's window (before previews − grace, or after close + grace) and is NOT
 * within any declared priorRun.
 *
 * fetch-guardian-reviews.js uses this to refuse storing a prior-production article
 * body that the Guardian Open Platform API returns when a revival's stored URL still
 * points at an earlier production's slug — the 2026 Glengarry WE entry was served the
 * 2017 Christian Slater review this way, which then masqueraded as the current review
 * (correctly flagged wrongProduction, but the real 2026 review was never fetched).
 * Pure + deterministic (no I/O).
 *
 * @param {object} show - show record (previewsStartDate/openingDate/closingDate/category/priorRuns)
 * @param {string} dateStr - article publication date (YYYY-MM-DD or ISO 8601)
 * @returns {boolean}
 */
function isArticleOutsideProductionWindow(show, dateStr) {
  if (!show || !dateStr) return false;
  const pubDate = new Date(dateStr);
  if (isNaN(pubDate.getTime())) return false;
  const decision = evaluateDateGuard({ pubDate, show, outletId: 'guardian' });
  if (!decision.flag) return false;
  // priorRun coverage is legitimate same-production history, not contamination.
  if (isWithinPriorRun(pubDate, show.priorRuns)) return false;
  // tourLeg coverage is the same current production at a different venue stop.
  if (isWithinTourLeg(pubDate, show.tourLegs)) return false;
  return true;
}

/**
 * Pure inclusion-time pre-window decision — the single source of truth for
 * "is this review published implausibly far before the show's run?" used by
 * rebuild-all-reviews.js (main inclusion pass + duplicate-reference replica)
 * and the scoring-delta.js simulator. Before extraction (card 386637c5) each
 * site duplicated the threshold math, and the sim had already drifted (no
 * priorRuns exemption).
 *
 * The caller keeps ownership of the bypass fields that differ per site
 * (allowEarlyDate, routedFromShowId, long-run-WE exemption, manual clears) —
 * this predicate decides only the date-vs-window question.
 *
 * @param {object} args
 * @param {Date|null} args.pubDate - parsed review publish date
 * @param {Date|null} args.showEarliest - parsed earliest show date (see earliestShowDate)
 * @param {boolean} args.isFlexCategory - off-broadway or London market (90d legacy family)
 * @param {Array|null|undefined} args.priorRuns - show.priorRuns; a covered date is
 *   legitimate earlier-run coverage, never excluded here
 * @param {Array|null|undefined} args.tourLegs - show.tourLegs; a covered date is
 *   legitimate current-production coverage at another venue stop, never excluded here
 * @returns {{ exclude: boolean, daysBefore: number|null, threshold: number, reason: 'pre-window date'|'prior-run window'|'tour-leg window'|null }}
 */
function evaluatePreWindowInclusion({ pubDate, showEarliest, isFlexCategory, priorRuns, tourLegs }) {
  const threshold = isFlexCategory ? PRE_WINDOW_DAYS : PRE_WINDOW_DAYS_BROADWAY;
  if (!pubDate || isNaN(pubDate.getTime()) || !showEarliest || isNaN(showEarliest.getTime())) {
    return { exclude: false, daysBefore: null, threshold, reason: null };
  }
  const daysBefore = Math.ceil((showEarliest - pubDate) / 86400000);
  if (daysBefore <= threshold) {
    return { exclude: false, daysBefore, threshold, reason: null };
  }
  if (isWithinPriorRun(pubDate, priorRuns)) {
    return { exclude: false, daysBefore, threshold, reason: 'prior-run window' };
  }
  if (isWithinTourLeg(pubDate, tourLegs)) {
    return { exclude: false, daysBefore, threshold, reason: 'tour-leg window' };
  }
  return { exclude: true, daysBefore, threshold, reason: 'pre-window date' };
}

module.exports = {
  evaluateDateGuard,
  evaluateDatelessRevivalGuard,
  earliestShowDate,
  isArticleOutsideProductionWindow,
  evaluatePreWindowInclusion,
  DAYS_BEFORE_PREVIEW,
  DAYS_AFTER_CLOSE,
  UK_DAYS_BEFORE_PREVIEW,
  PRE_WINDOW_DAYS,
  PRE_WINDOW_DAYS_BROADWAY,
};
