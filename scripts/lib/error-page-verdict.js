'use strict';

/**
 * error-page-verdict.js — an exclusion verdict that was judged on a saved
 * error page (BRO-7171 item a).
 *
 * 41 review files hold the outlet's own not-found page as their "text" (USA
 * Today "Page Not Found (404)", the Daily News / Newsday templates). Automated
 * judges then read that page and excluded the review: Gemini called 19 of them
 * "news" (isNonReview), the LLM content check wrote wrongShow "page not found",
 * the BRO-4383 write guard wrote wrongShow because the 404 page never names the
 * show. Those verdicts describe the error page, not the review (Elysa Gardner's
 * USA Today reviews, Charles Isherwood's), yet they keep the file EXCLUDED, so
 * the gap engine never looks for the real link.
 *
 * A file whose ONLY exclusions are such verdicts is a dead url, not an
 * exclusion: it goes to URL_DEAD -> URL_FIND/ARCHIVE. When real text is
 * accepted, voidErrorPageVerdicts moves the verdicts aside (breadcrumb
 * errorPageVerdictVoid, null-assigned, never deleted) in the same write, and
 * the new body is judged fresh (BRO-4383 write guard on arriving text, the
 * rescore). The breadcrumb is NOT a human clear: review-write-guard honours it
 * only to stop the push restore from resurrecting the exact voided values.
 *
 * Left alone (they stay EXCLUDED): any human verdict (_locked, manual tier,
 * human score, a "manual (not a review)" reason, manual-* detectors), and
 * verdicts whose evidence is not the body: cross-market notes, date guards,
 * audit/contamination reasons, a restored flag with no reason, duplicates,
 * roundups.
 *
 * Pure: no fs, no process.
 */

const VOID_BY = 'saved-error-page-verdict-void';

// wrongShow reasons that come from reading the stored body.
const BODY_WRONG_SHOW = /^(Write guard \(BRO-4383\)|LLM:|Collector LLM)|page not found|\b404\b|not a review/i;
// wrongProduction reasons that come from reading the stored body (an LLM verdict).
const BODY_WRONG_PRODUCTION = /^(LLM:|Collector LLM)|page not found|\b404\b/i;

const FAMILIES = {
  // classifiedAt goes too: classify-non-reviews --incremental skips any file
  // that has it, so leaving it would keep the recovered body from ever being
  // read by the classifier (second-opinion P2, 2026-11-10).
  isNonReview: ['isNonReview', 'isNonReviewReason', 'nonReviewType', 'nonReviewClassifiedBy', 'classifiedAt'],
  nonReviewFlag: ['nonReviewFlag', 'nonReviewType', 'nonReviewEvidence', 'nonReviewFlaggedAt', 'nonReviewMethod'],
  wrongShow: ['wrongShow', 'wrongShowReason', 'wrongShowAt'],
  wrongProduction: ['wrongProduction', 'wrongProductionReason', 'wrongProductionNote'],
};

function onSavedErrorPage(d) {
  if (!d || typeof d.fullText !== 'string' || !d.fullText) return false;
  return require('./soft-404-body').isSoft404Body(d.fullText);
}

function hasHumanOwner(d) {
  if (d._locked === true || d.manualContentTier != null || d.humanReviewScore != null) return true;
  if (d.isNotReview === true) return true;
  if (d.manualNonReviewSet === true) return true;
  if (typeof d.isNonReviewReason === 'string' && /^manual/i.test(d.isNonReviewReason)) return true;
  for (const k of ['wrongProductionDetectedBy', 'wrongShowSetBy', 'nonReviewSetBy']) {
    if (typeof d[k] === 'string' && /^(manual|human|audit)[-_]/i.test(d[k])) return true;
  }
  try { if (require('./contradicted-flag-basis').hasHumanAssertedFlag(d)) return true; } catch { /* optional */ }
  return false;
}

/**
 * Which live exclusions the record carries, split into those judged on the
 * saved error page (voidable) and the rest (blocking).
 * @returns {{onErrorPage:boolean, voidable:string[], blocking:string[]}}
 */
function errorPageVerdictBasis(d) {
  const out = { onErrorPage: onSavedErrorPage(d), voidable: [], blocking: [] };
  if (!d || typeof d !== 'object') return out;
  const human = hasHumanOwner(d);
  const put = (kind, bodyBased) => (bodyBased && !human ? out.voidable : out.blocking).push(kind);
  if (d.duplicateOf) out.blocking.push('duplicateOf');
  if (d.isRoundupArticle) out.blocking.push('isRoundupArticle');
  // Verdicts about the slot or attribution, not the stored body: a new body
  // does not answer them (and an invented url must never be archive-fetched).
  for (const k of ['fabricatedEntry', 'wrongAttribution', 'showNotMentioned', 'wrongArticle', 'wrongFullText']) {
    if (d[k] === true) out.blocking.push(k);
  }
  // A classifier verdict (model-stamped, or reasonless) read the body; a typed
  // reason with no classifier came from a hand fix or a url sweep.
  if (d.isNonReview === true) put('isNonReview', !d.isNonReviewReason || !!d.nonReviewClassifiedBy);
  if (d.nonReviewFlag === true) put('nonReviewFlag', true);
  if (d.wrongShow === true && !(d.wrongShowManualClear === true || d.wrongShowOverride === true)) {
    put('wrongShow', BODY_WRONG_SHOW.test(String(d.wrongShowReason || '')));
  }
  if (d.wrongProduction === true && !(d.wrongProductionManualClear === true || d.wrongProductionOverride === true || d.humanReviewedWrongProduction === false)) {
    put('wrongProduction', BODY_WRONG_PRODUCTION.test(String(d.wrongProductionReason || '')) && !d.wrongProductionNote);
  }
  return out;
}

/** The body is a saved error page and every live exclusion was judged on it. */
function isErrorPageVerdictOnly(d) {
  const b = errorPageVerdictBasis(d);
  return b.onErrorPage && b.voidable.length > 0 && b.blocking.length === 0;
}

/**
 * Move the error-page verdicts aside (null-assign, never delete) with the
 * errorPageVerdictVoid breadcrumb. Call only in the write that replaces the
 * error page with accepted text. Mutates. Returns the voided kinds ([] = no-op).
 */
function voidErrorPageVerdicts(d, { at = new Date().toISOString(), by = VOID_BY, why = null } = {}) {
  if (!isErrorPageVerdictOnly(d)) return [];
  const kinds = errorPageVerdictBasis(d).voidable;
  const prior = {};
  for (const k of kinds) {
    for (const f of FAMILIES[k]) {
      if (d[f] != null && !(f in prior)) prior[f] = d[f];
      d[f] = null;
    }
  }
  d.errorPageVerdictVoid = { at, by, kinds, ...(why ? { why } : {}), prior };
  return kinds;
}

/**
 * review-write-guard restore predicate: `field` was voided by this path and the
 * committed copy still holds exactly the voided value, so restoring it would
 * resurrect a verdict about the error page. A later re-flag (a different value,
 * or the breadcrumb gone) is still restored.
 */
function isErrorPageVoidedField(field, local, committed) {
  const v = local && local.errorPageVerdictVoid;
  if (!v || !v.prior || !Object.prototype.hasOwnProperty.call(v.prior, field)) return false;
  if (local[field] != null && local[field] !== false) return false;
  if (!committed || committed[field] == null) return false;
  // The committed copy is already past this void (it carries the same
  // breadcrumb), so its non-empty value was set on the new body: a re-flag.
  // A boolean re-flag equals the voided prior, so value equality alone cannot
  // tell them apart (second-opinion P1, 2026-11-10).
  const cv = committed.errorPageVerdictVoid;
  if (cv && cv.at && cv.at === v.at) return false;
  return JSON.stringify(committed[field]) === JSON.stringify(v.prior[field]);
}

const VOIDABLE_FIELDS = Object.freeze([...new Set(Object.values(FAMILIES).flat())]);

module.exports = {
  VOID_BY,
  VOIDABLE_FIELDS,
  errorPageVerdictBasis,
  isErrorPageVerdictOnly,
  voidErrorPageVerdicts,
  isErrorPageVoidedField,
};
