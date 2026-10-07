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
const { findMatchingPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');

const COLLECTOR_WP_PREFIX = 'Collector LLM: wrong production';
const MIN_TEXT_CHARS = 1500;
// Prior-run candidates are checked on whichever text the file holds, and a
// live fullText is often a shorter re-fetch (Totoro's Telegraph: 1,467 chars).
const PRIOR_RUN_MIN_TEXT_CHARS = 800;
const ENSEMBLE_REJECTOR = 'ensemble-scoreability-check';

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
  // Either human verdict settles it: false = cleared, true = confirmed.
  if (data.humanReviewedWrongProduction === false || data.humanReviewedWrongProduction === true) return false;
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
  resetWrongContentTier(data, classifyContentTier);
}

/**
 * Undo the collector's "Wrong production" invalid tier on a confirmed
 * release, keeping the file's text as is. Mutates `data`. Used directly when
 * the confirmed text is the live fullText (no restore needed).
 */
function resetWrongContentTier(data, classifyContentTier) {
  if (data.incompleteReason === 'wrong_content') {
    data.incompleteReason = null;
    data.incompleteDetail = null;
  }
  if (typeof classifyContentTier === 'function') {
    const tier = classifyContentTier(data);
    data.contentTier = tier.contentTier;
    data.contentTierReason = tier.tierReason;
    data.tierReason = tier.tierReason;
    data.wordCount = tier.wordCount;
  }
}

/**
 * Stamp a rejection so the same text is not re-verified. Mutates `data`.
 * `text` is the text the LLM was shown; defaults to the quarantined copy.
 */
function stampCollectorWpRejection(data, nowIso, text, hash) {
  data.collectorWpReverifiedHash = hash || quarantinedTextHash(text === undefined ? data.wrongFullText : text);
  data.collectorWpReverifiedAt = nowIso;
}

/**
 * Settled-verdict key for a prior-run re-check: the judged text PLUS the
 * show's declared runs. The verdict depends on those declarations (they are in
 * the prompt), so correcting a run's venue/dates must re-open the question
 * even when the text is unchanged.
 */
function priorRunVerdictHash(text, show) {
  // Only the fields the prompt's verdict rests on, so a cosmetic shows.json
  // edit (a note, a source url, key order) does not re-open settled verdicts.
  const pick = (r) => [r && r.venue, r && (r.openingDate || r.startDate), r && (r.closingDate || r.endDate)];
  const runs = JSON.stringify({
    priorRuns: ((show && show.priorRuns) || []).map(pick),
    tourLegs: ((show && show.tourLegs) || []).map(pick),
  });
  return quarantinedTextHash(`${String(text || '').substring(0, 5000)}\n${runs}`);
}

/**
 * wrongProduction files dated inside a DECLARED earlier run / tour leg of the
 * show (show.priorRuns / show.tourLegs). The collector's verifier was never
 * told about those runs, so it called reviews of them "a different
 * production", and a "Collector LLM" reason is not one
 * shouldAutoClearWrongProductionPriorRun may override. Returns the file's
 * bucket so the sweep can re-ask only what an LLM second look can settle:
 *
 *   candidate — collector-LLM flag, enough text, not yet asked about this text.
 *               `textField` names the text to show the LLM ('fullText' when the
 *               file holds a live one, else the quarantined 'wrongFullText',
 *               which a confirmed release restores).
 *   ensemble  — >=2 scoring models rejected it; an override must not clear
 *               that, it needs a rescore with the prior-run context.
 *   operator  — an operator/audit free-text reason (audit-*, Re-excluded,
 *               adjudication, Edinburgh notes): report only.
 *   settled   — already asked about this exact text.
 *   no-text   — collector flag but no usable text to re-check.
 *   other     — any other flag source (date guards, cross-market notes,
 *               wrongShow/duplicate files, operator-protected collector flags):
 *               left to their own clearing paths.
 * Returns null when the file is not flagged or not inside a declared window.
 *
 * @param {object} data - review-text JSON
 * @param {object} show - shows.json entry
 * @param {{ isGarbage?: (text: string) => boolean }} [ctx]
 * @returns {{ bucket: string, window: object|null, textField?: string, text?: string }|null}
 */
function classifyPriorRunWrongProduction(data, show, ctx = {}) {
  if (!data || !show || data.wrongProduction !== true || !data.publishDate) return null;
  const run = findMatchingPriorRun(data.publishDate, show.priorRuns);
  const inLeg = !run && isWithinTourLeg(data.publishDate, show.tourLegs);
  if (!run && !inLeg) return null;
  const window = run || { tourLeg: true };
  if (data.rejectedBy === ENSEMBLE_REJECTOR) return { bucket: 'ensemble', window };
  const reason = String(data.wrongProductionReason || '');
  if (!reason.startsWith(COLLECTOR_WP_PREFIX)) {
    return { bucket: reason.trim() ? 'operator' : 'other', window };
  }
  // humanReviewedWrongProduction === true is a human CONFIRMING the flag: an
  // LLM second look must never overturn it (=== false is a human clear).
  if (data.wrongProductionManualClear === true || data.wrongProductionOverride === true
    || data.humanReviewedWrongProduction === false || data.humanReviewedWrongProduction === true
    || data.wrongShow === true || data.duplicateOf
    || data.isNonReview === true || data.isNotReview === true || data.nonReviewFlag === true) {
    return { bucket: 'other', window };
  }
  // Prefer the live fullText when it is usable. Fall back to the quarantined
  // copy only when the live text is not usable (Totoro's Telegraph: 1,467
  // chars of page chrome) AND the url was never rewritten — after a rewrite
  // the quarantined text may describe the old url's article, and a release
  // restores it over the live text.
  const isUsable = (t) => t.length >= PRIOR_RUN_MIN_TEXT_CHARS
    && !(typeof ctx.isGarbage === 'function' && ctx.isGarbage(t));
  const hasUrlRewrite = !!(data.urlCorrectedFrom || data.urlUpdatedFrom || data._urlChangedClear);
  const live = String(data.fullText || '');
  const quarantined = String(data.wrongFullText || '');
  let textField = null;
  if (isUsable(live)) textField = 'fullText';
  else if (isUsable(quarantined) && !hasUrlRewrite) textField = 'wrongFullText';
  if (!textField) return { bucket: 'no-text', window };
  const text = textField === 'fullText' ? live : quarantined;
  if (data.collectorWpReverifiedHash && data.collectorWpReverifiedHash === priorRunVerdictHash(text, show)) {
    return { bucket: 'settled', window };
  }
  return { bucket: 'candidate', window, textField, text };
}

module.exports = {
  COLLECTOR_WP_PREFIX,
  ENSEMBLE_REJECTOR,
  isCollectorWrongProductionCandidate,
  classifyPriorRunWrongProduction,
  restoreQuarantinedText,
  resetWrongContentTier,
  stampCollectorWpRejection,
  quarantinedTextHash,
  priorRunVerdictHash,
};
