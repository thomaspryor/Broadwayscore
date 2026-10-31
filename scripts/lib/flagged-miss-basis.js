/**
 * Who excluded a round-up-listed review, and should it be re-checked (BRO-4971).
 *
 * audit-show-review-gap.js collects `flaggedMisses`: reviews a reference
 * round-up (Best of Theatre, WestEndTheatre, theatre.reviews, LBO, the NYC
 * aggregators) lists for the show, where we hold a file but the rebuild
 * excludes it. That list was report-only, so an automated false-positive
 * exclusion sat there forever. A backtest found 5 of 16 London rows were
 * false positives: a CV wrongProduction, a CV-promoted isNonReview 'preview',
 * a stale same-URL sibling slot, a heuristic awards_coverage, a showNotMentioned.
 *
 * A round-up listing the review is independent evidence against an AUTOMATED
 * verdict, but not against a human one. So each row is split:
 *   humanExcluded     - some excluded file for the URL carries a human assertion
 *                       (never second-guessed; no re-verify)
 *   automatedExcluded - every excluded file was excluded by a detector; `basis`
 *                       names which (explainExclusion reasons)
 * and an automated row listed by a CURRENT-run round-up (not a prior-production
 * citation) gets `reverify: true`.
 *
 * Reporting only: nothing here changes what the rebuild includes.
 * Pure: no fs, no process.
 */

'use strict';

const { hasHumanAssertedFlag } = require('./contradicted-flag-basis');
const { isHumanRejecter } = require('./stale-automated-text-verdict');
const { isPriorProductionCitation } = require('./prior-production-citations');

// Breadcrumb keys a person (or an operator-run triage) writes when asserting an
// exclusion, e.g. wrongProductionManual / isNonReviewManual. `...ManualClear`
// is the opposite (a human UN-excluded it) and is not an exclusion assertion.
const MANUAL_SUFFIX = /Manual$/;

/**
 * True when the file's exclusion carries a human assertion. Superset of
 * contradicted-flag-basis.js hasHumanAssertedFlag: also _locked, a manual-/
 * human-/audit- rejectedBy, isNotReview, manualContentTier, and *Manual flags.
 */
function hasHumanExclusionAssertion(d) {
  if (!d || typeof d !== 'object') return false;
  if (hasHumanAssertedFlag(d)) return true;
  if (d._locked) return true;
  if (isHumanRejecter(d.rejectedBy)) return true;
  if (d.isNotReview === true) return true;
  if (d.manualContentTier != null) return true;
  if (typeof d.nonReviewMethod === 'string' && /^(manual|human)/i.test(d.nonReviewMethod)) return true;
  return Object.keys(d).some(k => MANUAL_SUFFIX.test(k) && d[k] === true);
}

// Raw detector fields, read when the canonical reason is unavailable. Some
// rebuild-only guards (showNotMentioned: text scan + LLM CV) are not mirrored
// by review-guards explainExclusion, which then reports nothing for the file.
const RAW_DETECTOR_FIELDS = ['wrongProduction', 'wrongShow', 'isNonReview', 'nonReviewFlag',
  'showNotMentioned', 'rejectionReason', 'isRoundupArticle', 'duplicateOf'];

function rawDetectorBasis(d) {
  const hit = RAW_DETECTOR_FIELDS.find(k => d[k] != null && d[k] !== false && d[k] !== '');
  return hit || null;
}

// BRO-5500: a CV verdict that this piece is a non-review (preview, news, a critic
// who did not see the show) with HIGH confidence AND a promoted isNonReview exclusion
// is the detector agreeing with the round-up on the URL but not on "review": the
// round-up merely linked an article. Re-verifying it only reproduces the verdict, so
// it must not hold roundup-gap:all open forever (anon-a-tempest frontmezzjunkies).
const NONREVIEW_ARTICLE_TYPES = new Set(['preview', 'news', 'feature', 'interview', 'press-release']);
// BRO-5391: announcement/press-release pieces (a roundup merely linked the news
// post) are non-reviews too, via two other verdicts: a >=3-model-agreement
// scoreability-ensemble rejection, or a human-verified non-review (isNotReview + nonReviewMethod 'manual-verified').
function isEnsembleNonReview(d) {
  return !!d && d.rejectionReason === 'not_a_review' && d.rejectedBy === 'ensemble-scoreability-check'
    && Number(d.rejectionAgreeCount) >= 3;
}
function isHumanConfirmedNonReview(d) {
  return !!d && d.isNotReview === true && d.rejectionReason === 'not_a_review'
    && d.nonReviewMethod === 'manual-verified';
}
// BRO-5514: Time Out serves an unsigned listing capsule (~90 words) at review-shaped
// URLs; collect-review-texts tags it url_content_mismatch/timeout_listing_capsule.
// Time Out swaps a closed show's review for this blurb at the same URL, so the
// text is unrecoverable from here; there is nothing capturable behind the URL.
function isTimeoutListingCapsule(d) {
  return !!d && d.incompleteReason === 'url_content_mismatch'
    && typeof d.incompleteDetail === 'string' && d.incompleteDetail.startsWith('timeout_listing_capsule');
}
// BRO-5514: a syndicated reprint (same text, other outlet's URL) is a correct
// exclusion ONLY if its primary is actually held and counted in this show. The
// pointer alone is not proof: it can dangle, cross shows, or name an excluded
// primary (heal-dangling-syndication.js / heal-syndicated-duplicates.js), in
// which case the rebuild still drops the reprint and the review counts nowhere.
// `isHeldPrimary` is supplied by the audit, which holds the show's dir files.
function isHeldSyndicatedReprint(d, isHeldPrimary) {
  return !!d && d.isSyndicatedDuplicate === true && !!d.syndicatedPrimaryFile
    && Number(d.syndicationSimilarity) >= 80
    && typeof isHeldPrimary === 'function' && !!isHeldPrimary(d);
}
// BRO-6689: the CV pass reads a (often truncated, plot-heavy) slice of the body, so its
// "preview/feature, not a review" verdict can be wrong. Real reviews were hidden that way
// (culturesauce 4/5 stars, theatermania 'review-...' pages, theater-scene, stagezine). When
// the ONLY non-review evidence is that LLM verdict, review-shaped evidence on the file
// contradicts it: an extracted star/score rating, or a verdict excerpt an aggregator quoted.
// Deliberately body/field based, not URL-slug based: slugs match round-ups and miss cases.
function hasValue(v) {
  return v != null && v !== false && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null';
}
function hasReviewShapedEvidence(d) {
  if (!d) return false;
  return hasValue(d.originalScore) || hasValue(d.showScoreExcerpt) || hasValue(d.humanReviewScore);
}
// Deterministic exclusions (date gates) are not LLM opinions; a rating on the page does not
// undo "published 10 days before opening" (BRO-6689 monstagigz: self-labelled preview).
const DETERMINISTIC_GATE_REASONS = new Set(['anticipatory_pre_opening_post', 'dateless-revival']);
function isDeterministicGateExclusion(d) {
  return DETERMINISTIC_GATE_REASONS.has(d.wrongProductionReason) || DETERMINISTIC_GATE_REASONS.has(d.wrongShowReason);
}
// "Confirmed" = the exclusion is the correct outcome (a non-review, a Time Out
// listing capsule, a held syndicated reprint), not a gap. Name kept from BRO-5500.
function isConfirmedNonReviewFile(d, isHeldPrimary) {
  if (isEnsembleNonReview(d) || isHumanConfirmedNonReview(d)) return true;
  if (isTimeoutListingCapsule(d) || isHeldSyndicatedReprint(d, isHeldPrimary)) return true;
  const cv = d && d.contentVerification;
  if (!cv || cv.isValid !== false || cv.confidence !== 'high') return false;
  if (cv.articleTypeConfidence !== 'high' || !NONREVIEW_ARTICLE_TYPES.has(cv.articleType)) return false;
  if (!(d.isNonReview === true && d.rejectionReason === 'not_a_review')) return false;
  return isDeterministicGateExclusion(d) || !hasReviewShapedEvidence(d);
}

/**
 * Classify one flaggedMiss from its excluded dir files.
 * @param {object[]} files - the excluded dir files for the listed URL
 * @param {(d: object) => (string|null)} [explain] - exclusion reason for a file
 *   (review-guards explainExclusion bound to the show); null/throw falls back
 *   to the raw detector field, then 'unknown'
 * @returns {{ exclusion: 'humanExcluded'|'automatedExcluded', basis: string[] }}
 */
function classifyFlaggedMiss(files, explain, isHeldPrimary) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const human = list.some(hasHumanExclusionAssertion);
  const basis = [];
  for (const d of list) {
    let reason = null;
    try { reason = explain ? explain(d) : null; } catch { reason = null; }
    const r = reason || rawDetectorBasis(d) || 'unknown';
    if (!basis.includes(r)) basis.push(r);
  }
  // A human assertion normally means "never second-guess"; it only counts as a
  // confirmed non-review when the human said so (isNotReview), not e.g. wrongProduction.
  const confirmedNonReview = list.length > 0 && list.every(d => isConfirmedNonReviewFile(d, isHeldPrimary))
    && (!human || list.every(isHumanConfirmedNonReview));
  return { exclusion: human ? 'humanExcluded' : 'automatedExcluded', basis, confirmedNonReview };
}

/** Re-check an automated exclusion only when a current-run round-up lists it. */
function shouldReverify(m) {
  return !!m && m.exclusion === 'automatedExcluded' && !m.confirmedNonReview && !isPriorProductionCitation(m);
}

/** Count of flaggedMisses marked reverify (automated, current-run listed). */
function countAutomatedExcludedListed(flaggedMisses) {
  return Array.isArray(flaggedMisses) ? flaggedMisses.filter(m => m && m.reverify === true).length : 0;
}

module.exports = {
  hasHumanExclusionAssertion,
  rawDetectorBasis,
  classifyFlaggedMiss,
  isConfirmedNonReviewFile,
  hasReviewShapedEvidence,
  shouldReverify,
  countAutomatedExcludedListed,
};
