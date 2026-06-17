/**
 * Wrong-Production Auto-Clear Decision
 *
 * Pure decision functions for deciding whether the rebuild's auto-clear
 * paths should strip wrongProduction / wrongShow flags from a review file.
 *
 * Background: rebuild-all-reviews.js has auto-clear paths that strip
 * wrongProduction when allowEarlyDate or allowCrossMarket is true.
 * Without guards, these paths strip flags even when the user/audit/CV
 * explicitly set wrongProduction with a reason — re-introducing
 * cross-market contamination on every rebuild.
 *
 * Used by:
 * - scripts/rebuild-all-reviews.js (main rebuild loop, allowEarlyDate auto-clear)
 * - scripts/flag-wrong-production-by-date.js (Date-guard pre-flag check)
 * - tests/unit/wrong-production-autoclear.test.mjs
 */

const { parseDate } = require('./date-utils');

/**
 * Decide whether a review's publishDate falls inside any of the show's
 * prior-run windows (Phase 1 production-continuity model).
 *
 * Each priorRun describes a previous run of the same artistic production
 * (workshop → mainstage transfer, return engagement, etc.). A review whose
 * publishDate sits inside priorRun.openingDate..closingDate is legitimate
 * coverage of an earlier run of THIS production and must not be flagged
 * wrongProduction by date-only guards.
 *
 * Defaults / edge cases:
 *  - reviewDate / priorRuns missing or empty → false (caller falls back to
 *    the existing 90-day pre-opening guard).
 *  - openingDate missing / unparseable on a priorRun entry → that entry is
 *    skipped (other entries still evaluated).
 *  - closingDate missing on a priorRun → window extends 180 days past
 *    openingDate (limited-run default; matches OB lab/showcase typical run).
 *  - Comparison is inclusive of both bounds and date-only (UTC midnight).
 *
 * @param {Date|string|null} reviewDate - Review publish date (Date or ISO/parseable string)
 * @param {Array<{openingDate?: string, closingDate?: string, venue?: string}>} priorRuns
 * @returns {boolean}
 */
function isWithinPriorRun(reviewDate, priorRuns) {
  if (!reviewDate || !Array.isArray(priorRuns) || priorRuns.length === 0) return false;
  const rd = reviewDate instanceof Date ? reviewDate : parseDate(reviewDate);
  if (!rd || isNaN(rd.getTime())) return false;
  const rdMs = rd.getTime();

  for (const run of priorRuns) {
    if (!run || !run.openingDate) continue;
    const open = parseDate(run.openingDate);
    if (!open || isNaN(open.getTime())) continue;
    let close;
    if (run.closingDate) {
      close = parseDate(run.closingDate);
      if (!close || isNaN(close.getTime())) close = undefined;
    }
    if (!close) {
      close = new Date(open.getTime());
      close.setUTCDate(close.getUTCDate() + 180);
    }
    if (rdMs >= open.getTime() && rdMs <= close.getTime()) return true;
  }
  return false;
}

/**
 * Decide whether an existing wrongProduction flag — set by the date-only
 * Pre-opening guard or Date guard — should be auto-cleared because the
 * show now declares a priorRuns window that covers the review's date.
 *
 * Returns true ONLY if all conditions hold:
 *  - data.wrongProduction === true
 *  - data.wrongProductionNote starts with "Pre-opening guard" OR "Date guard"
 *    (the auto-flagger family — never strips flags from manual / CV / cross-market)
 *  - data.publishDate parses
 *  - show.priorRuns covers data.publishDate
 *  - No data.wrongProductionReason (manual / audit reason)
 *  - No high-confidence CV wrongProduction or wrongArticle
 *
 * Mirrors the safety guards used by shouldAutoClearWrongProductionUrlYear.
 *
 * @param {object} data - The review JSON object
 * @param {{ priorRuns?: Array<object> }} show - The show config
 * @returns {boolean}
 */
// Auto-set wrongProductionReason values that are date-only (NOT operator-set).
// These are written by date-based setters and are valid candidates for priorRuns
// auto-clear. Anything not in this set (and not in the auto-prefix list below)
// is treated as a manual reason and protected.
const DATE_ONLY_AUTO_REASONS = new Set([
  'anticipatory_pre_opening_post', // collect-review-texts.js anticipatory gate
]);
// Auto-set wrongProductionReason PREFIXES that priorRuns is allowed to override.
// CV-promoted reasons specifically include "CV identifies a different venue/run"
// — exactly what an operator-declared priorRun overrides. Operator-trust over CV
// is the Phase 1 design (parent card 351637c5-416f-81fe).
const AUTO_REASON_PREFIXES = [
  'CV-promoted:',
  'CV-low-but-strong-signal:',
];

function shouldAutoClearWrongProductionPriorRun(data, show) {
  if (!data || data.wrongProduction !== true) return false;
  if (!show || !Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return false;
  const note = data.wrongProductionNote || '';
  // Date-only auto-flag prefixes that priorRuns is allowed to override:
  //  - "Pre-opening guard" (rebuild-all-reviews.js inclusion + flag pass)
  //  - "Date guard" (flag-wrong-production-by-date.js standalone)
  //  - "Auto-flagged" (gather-reviews.js Broadway-only ingest guard)
  //  - "Review published" (rebuild-all-reviews.js per-review skip-pre-opening writer)
  const isDateOnlyAutoFlag = note.startsWith('Pre-opening guard')
    || note.startsWith('Date guard')
    || note.startsWith('Auto-flagged')
    || note.startsWith('Review published');
  // The anticipatory ingest gate + CV-promotion paths write ONLY
  // wrongProductionReason (no Note). Recognize their auto-set values as
  // override-eligible.
  const reason = data.wrongProductionReason || '';
  const isAutoReason = DATE_ONLY_AUTO_REASONS.has(reason)
    || AUTO_REASON_PREFIXES.some(p => reason.startsWith(p));
  if (!isDateOnlyAutoFlag && !isAutoReason) return false;
  if (!data.publishDate) return false;
  if (!isWithinPriorRun(data.publishDate, show.priorRuns)) return false;
  // Treat reason as "manual" only when it's not in the auto-set allowlist.
  const hasManualReason = !!reason && !isAutoReason;
  // CV-confirmed gate: still respect high-conf CV wrongArticle (entirely
  // different show, not just different production). Phase 1 trusts priorRuns
  // over CV's wrongProduction (venue/date match) but NOT over wrongArticle.
  const cvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrongArticle;
}

/**
 * Decide whether the allowEarlyDate/allowCrossMarket auto-clear should
 * strip wrongProduction from a review file.
 *
 * Returns true ONLY if both conditions hold:
 *   - One of allowEarlyDate / allowCrossMarket is true (user explicit override)
 *   - There is NO explicit wrongProductionReason and NO high-confidence CV signal
 *     (so the flag is safe to clear)
 *
 * @param {object} data - The review JSON object
 * @returns {boolean} - true if it's safe to delete wrongProduction
 */
function shouldAutoClearWrongProduction(data) {
  if (data.wrongProduction !== true) return false;
  if (!data.allowEarlyDate && !data.allowCrossMarket) return false;
  const hasManualReason = !!data.wrongProductionReason;
  const cvConfirmedWrong = data.contentVerification?.wrongProduction === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrong;
}

/**
 * Same logic for wrongShow flag (parallel auto-clear path).
 *
 * @param {object} data
 * @returns {boolean}
 */
function shouldAutoClearWrongShow(data) {
  if (data.wrongShow !== true) return false;
  if (!data.allowEarlyDate && !data.allowCrossMarket) return false;
  const hasManualReason = !!data.wrongShowReason;
  const cvConfirmedWrong = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrong;
}

/**
 * Decide whether the WE/OB URL-year auto-clear path should strip wrongProduction.
 *
 * The URL-year guard sets wrongProduction=true when a review URL contains a year
 * that doesn't match the show's season. For West End and off-Broadway shows this
 * is a known false-positive source (transfers, unconventional year tags) and the
 * rebuild exempts them — but only if the flag wasn't set for some OTHER explicit
 * reason (manual audit, high-confidence CV).
 *
 * Callers pass `isLondonOrOffBroadway` so this lib stays decoupled from
 * isLondonMarket() / show-category imports.
 *
 * @param {object} data
 * @param {object} ctx
 * @param {boolean} ctx.isLondonOrOffBroadway - true if showCat is london/off-broadway
 * @returns {boolean}
 */
function shouldAutoClearWrongProductionUrlYear(data, { isLondonOrOffBroadway } = {}) {
  if (data.wrongProduction !== true) return false;
  if (!data.wrongProductionNote || !data.wrongProductionNote.includes('URL contains year')) return false;
  if (!isLondonOrOffBroadway) return false;
  const hasManualReason = !!data.wrongProductionReason;
  const cvConfirmedWrong = data.contentVerification?.wrongProduction === true
    && data.contentVerification?.confidence === 'high';
  const cvConfirmedWrongArticle = data.contentVerification?.wrongArticle === true
    && data.contentVerification?.confidence === 'high';
  return !hasManualReason && !cvConfirmedWrong && !cvConfirmedWrongArticle;
}

/**
 * Decide whether the UK-URL wrongShow auto-clear path should strip wrongShow.
 *
 * When wrongShow was set on a London-market file whose URL is a UK outlet,
 * it's almost always an LLM false-positive (UK outlets only cover London
 * theatre). But: respect manual wrongShowReason, CV-confirmed wrongArticle,
 * and date-mismatches (review >90 days before open = prior production).
 *
 * Callers pass `isLondonMarketShow`, `isUkOutletUrl`, `dateMismatchOver90d`
 * so this lib stays decoupled from venue-classification / parseDate.
 *
 * @param {object} data
 * @param {object} ctx
 * @param {boolean} ctx.isLondonMarketShow
 * @param {boolean} ctx.isUkOutletUrl
 * @param {boolean} ctx.dateMismatchOver90d
 * @returns {boolean}
 */
function shouldAutoClearWrongShowUkUrl(data, { isLondonMarketShow, isUkOutletUrl, dateMismatchOver90d } = {}) {
  if (data.wrongShow !== true) return false;
  if (!isLondonMarketShow) return false;
  if (!isUkOutletUrl) return false;
  if (dateMismatchOver90d) return false;
  const isWrongArticle = data.contentVerification?.wrongArticle === true;
  const hasManualReason = !!data.wrongShowReason;
  return !isWrongArticle && !hasManualReason;
}

/**
 * Decide whether a "Dateless revival guard" wrongProduction flag should be
 * auto-cleared. That guard (scripts/lib/date-guard.js → evaluateDatelessRevivalGuard)
 * holds a review that has NO usable date on a recent revival title. It is a
 * provisional HOLD, not a verdict: the moment the review gains a usable date
 * (backfill / re-scrape) the proper dated guard should own the decision, and an
 * explicit human override must always win. This strips only our own flag —
 * recognised by its note prefix or reason — never a manual/CV/cross-market flag.
 *
 * @param {object} data - the review JSON object
 * @param {object} ctx
 * @param {boolean} ctx.hasUsableDate - true if the review now has a usable date
 *   (parsed publishDate or YYYYMMDD URL date)
 * @returns {boolean}
 */
function shouldAutoClearDatelessRevival(data, { hasUsableDate } = {}) {
  if (!data || data.wrongProduction !== true) return false;
  const note = data.wrongProductionNote || '';
  const reason = data.wrongProductionReason || '';
  const isOurs = note.startsWith('Dateless revival guard') || reason === 'dateless-revival';
  if (!isOurs) return false;
  const humanOverride = !!data.allowEarlyDate
    || !!data.wrongProductionManualClear
    || data.humanReviewedWrongProduction === true;
  return !!hasUsableDate || humanOverride;
}

module.exports = {
  shouldAutoClearWrongProduction,
  shouldAutoClearWrongShow,
  shouldAutoClearWrongProductionUrlYear,
  shouldAutoClearWrongShowUkUrl,
  isWithinPriorRun,
  shouldAutoClearWrongProductionPriorRun,
  shouldAutoClearDatelessRevival,
};
