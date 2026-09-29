'use strict';

/**
 * collector-wp-release.js — second look at wrongProduction flags the text
 * collector set from its own LLM verdict (BRO-4185 C).
 *
 * collect-review-texts.js flags `Collector LLM: wrong production (...)` and
 * moves the fetched text into `wrongFullText`, nulling `fullText`. That makes
 * the file invisible to isLikelyStaleWrongProduction (it needs fullText), so
 * a false verdict never gets re-examined. A 2026-09-28 corpus pass found 457
 * such flags, 116 dated inside the show's own run; hand-checked samples were
 * a mix of genuine calls (a Berkeley Rep Angels in America, a Boston tour stop)
 * and false ones (Playbill's Disgraced, NYT's Festen, Royal Court's Archduke),
 * too mixed for a deterministic release. These candidates therefore go to the
 * same Sonnet high-confidence check clear-stale-wrong-production-flags.js runs,
 * on the quarantined text.
 *
 * Each file is asked once per distinct quarantined text: a rejection stamps
 * the text's hash, and the candidate predicate skips a file whose stamp
 * matches, so the daily/weekly sweep does not re-spend on settled verdicts.
 */

const crypto = require('crypto');

const COLLECTOR_WP_PREFIX = 'Collector LLM: wrong production';
const MIN_TEXT_CHARS = 1500;

function quarantinedTextHash(text) {
  return crypto.createHash('md5').update(String(text || '').substring(0, 5000)).digest('hex');
}

/**
 * @param {object} data - review-text JSON
 * @param {object} show - shows.json entry
 * @param {object} ctx
 * @param {(show: object, publishDate: string) => boolean} ctx.inOwnWindow
 * @param {(text: string) => boolean} ctx.isGarbage
 */
function isCollectorWrongProductionCandidate(data, show, ctx = {}) {
  if (!data || !show || data.wrongProduction !== true) return false;
  if (!String(data.wrongProductionReason || '').startsWith(COLLECTOR_WP_PREFIX)) return false;
  if (data.wrongProductionManualClear === true || data.wrongProductionOverride === true) return false;
  if (data.humanReviewedWrongProduction === false) return false;
  if (data.wrongShow === true || data.duplicateOf) return false;
  // Quarantined shape only: the text lives in wrongFullText.
  if (data.fullText && String(data.fullText).length >= 200) return false;
  const text = String(data.wrongFullText || '');
  if (text.length < MIN_TEXT_CHARS) return false;
  // Garbage/consent captures go to the collector's refetch drain instead.
  if (typeof ctx.isGarbage === 'function' && ctx.isGarbage(text)) return false;
  if (!data.publishDate || typeof ctx.inOwnWindow !== 'function') return false;
  if (!ctx.inOwnWindow(show, data.publishDate)) return false;
  // Already asked about this exact text.
  if (data.collectorWpReverifiedHash && data.collectorWpReverifiedHash === quarantinedTextHash(text)) return false;
  return true;
}

/**
 * Restore the quarantined text on a confirmed release. Mutates `data`.
 * The caller clears the flag family (clearWrongProductionFlags) and stamps
 * wrongProductionManualClear, which the rebuild's CV promotion honours
 * (shouldSkipWrongProductionAudit), so the old verdict cannot re-flag it.
 */
function restoreQuarantinedText(data, classifyContentTier) {
  data.fullText = data.wrongFullText;
  // wrongFullText is left in place: its delete is honoured at push only with
  // wrongArticleManualClear, the human "this IS a review" hatch that also
  // turns off article-type exclusions for good (ship-check P0). A copy in
  // wrongFullText beside a live fullText excludes nothing.
  if (data.incompleteReason === 'wrong_content') data.incompleteReason = null;
  data.incompleteDetail = null;
  if (typeof classifyContentTier === 'function') {
    const tier = classifyContentTier(data);
    data.contentTier = tier.contentTier;
    data.contentTierReason = tier.tierReason;
    data.tierReason = tier.tierReason;
    data.wordCount = tier.wordCount;
  }
}

/** Stamp a rejection so the same text is not re-verified. Mutates `data`. */
function stampCollectorWpRejection(data, nowIso) {
  data.collectorWpReverifiedHash = quarantinedTextHash(data.wrongFullText);
  data.collectorWpReverifiedAt = nowIso;
}

module.exports = {
  COLLECTOR_WP_PREFIX,
  isCollectorWrongProductionCandidate,
  restoreQuarantinedText,
  stampCollectorWpRejection,
  quarantinedTextHash,
};
