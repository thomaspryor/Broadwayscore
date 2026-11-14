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
const { parsePointer } = require('./cross-outlet-cycle');

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
// `isHeldFile(pointer, d)` is supplied by the audit, which holds the show's dir files:
// true when the pointer resolves (scripts/lib/cross-outlet-cycle.js parsePointer, bare
// names against d's owning show) to another file of the SAME owning show that the
// rebuild counts. A syndication pointer must name its show explicitly (BRO-5514).
function isHeldSyndicatedReprint(d, isHeldFile) {
  return !!d && d.isSyndicatedDuplicate === true && typeof d.syndicatedPrimaryFile === 'string'
    && d.syndicatedPrimaryFile.includes('/')
    && Number(d.syndicationSimilarity) >= 80
    && typeof isHeldFile === 'function' && !!isHeldFile(d.syndicatedPrimaryFile, d);
}
// BRO-6689: the CV pass reads a (often truncated, plot-heavy) slice of the body, so its
// "preview/feature, not a review" verdict can be wrong. Real reviews were hidden that way
// (culturesauce 4/5 stars, theatermania 'review-...' pages, theater-scene, stagezine). When
// the ONLY non-review evidence is that LLM verdict, review-shaped evidence on the file
// contradicts it: an extracted star/score rating, or a verdict excerpt an aggregator quoted.
// (originalScore can occasionally be relayed from an aggregator, BRO-6018; at worst that only
// sends the row to re-verify, it never un-excludes anything.)
// Deliberately body/field based, not URL-slug based: slugs match round-ups and miss cases.
function hasValue(v) {
  return v != null && v !== false && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'null';
}
function hasReviewShapedEvidence(d) {
  if (!d) return false;
  return hasValue(d.originalScore) || hasValue(d.showScoreExcerpt);
}
// Deterministic exclusions (date gates) are not LLM opinions; a rating on the page does not
// undo "published 10 days before opening" (BRO-6689 monstagigz: self-labelled preview).
// Any wrongProduction/wrongShow reason that is not an LLM verdict text came from a rule
// (anticipatory_pre_opening_post, dateless-revival, prior-run-republish, date guards, ...).
// humanReviewScore is not a signal here: it makes the row humanExcluded upstream.
const LLM_REASON = /\b(LLM|CV-promoted|Collector)\b/i;
function isDeterministicGateExclusion(d) {
  return [['wrongProduction', 'wrongProductionReason', 'wrongProductionNote'], ['wrongShow', 'wrongShowReason', 'wrongShowNote']]
    .some(([flag, reason, note]) => {
      if (d[flag] !== true) return false; // a cleared flag's leftover reason is a breadcrumb, not an exclusion
      const text = [d[reason], d[note]].filter(x => typeof x === 'string' && x.trim()).join(' ');
      return text !== '' && !LLM_REASON.test(text);
    });
}
// "Confirmed" = the exclusion is the correct outcome (a non-review, a Time Out
// listing capsule, a held syndicated reprint), not a gap. Name kept from BRO-5500.
function isConfirmedNonReviewFile(d, isHeldFile) {
  if (isEnsembleNonReview(d) || isHumanConfirmedNonReview(d)) return true;
  if (isTimeoutListingCapsule(d) || isHeldSyndicatedReprint(d, isHeldFile)) return true;
  const cv = d && d.contentVerification;
  if (!cv || cv.isValid !== false || cv.confidence !== 'high') return false;
  if (cv.articleTypeConfidence !== 'high' || !NONREVIEW_ARTICLE_TYPES.has(cv.articleType)) return false;
  if (!(d.isNonReview === true && d.rejectionReason === 'not_a_review')) return false;
  return isDeterministicGateExclusion(d) || !hasReviewShapedEvidence(d);
}

// BRO-6687: rule-made exclusions that are the correct outcome even though no human or
// non-review verdict confirms them. Each rule keys on the REAL explain() reason (the
// rebuild's own verdict for this file); a null/throwing explain never confirms, and the
// rawDetectorBasis fallback is never used here. Returns the rule name or null.
//  (a) knownSyndicationSecondary: review-guards already verified an includable primary.
//  (b) isRoundupArticle set by a rule: roundup URL pattern or an 'auto:' reason.
//  (c) duplicateOf / crossOutletDuplicate whose pointer names a held, counted file of
//      the same owning show (a copy of something already counted).
//  (d) wrongProduction/wrongShow from an automated rule is deliberately NOT confirmed: the
//      setters write free-text reasons (date guards, tour/transfer, URL-year, adjudicator
//      provider tags) that no pattern can tell apart from LLM or date-family verdicts, and a
//      real preview-period review an aggregator cites must reach a person (ship-check review
//      2026-10-31 found 9+ unlisted reason shapes across 559 files). Those stay reverify.
//  (e) wrong_production/wrong_show rejected by the scoreability ensemble with >=3 models
//      agreeing (BRO-5391 precedent for not_a_review), and only when that rejection is the
//      reason the rebuild excludes the file (stale ensemble fields under another reason do
//      not count). garbage_text deliberately excluded.
const ENSEMBLE_WRONG_REASONS = new Set(['wrong_production', 'wrong_show']);
// explain() reasons an ensemble wrong_production/wrong_show rejection surfaces as.
const ENSEMBLE_EXCLUSION_REASONS = new Set(['rejectionReason', 'wrongProduction', 'wrongShow']);
function ruleConfirmedBasis(d, reason, isHeldFile, isRoundupUrl) {
  if (!d || !reason) return null;
  if (reason === 'knownSyndicationSecondary') return 'syndication-primary-held';
  if (reason === 'isRoundupArticle') {
    const byUrl = typeof isRoundupUrl === 'function' && !!(isRoundupUrl(d.url) || {}).isRoundup;
    const byRule = typeof d.roundupArticleReason === 'string' && d.roundupArticleReason.startsWith('auto:');
    return byUrl || byRule ? 'roundup-rule' : null;
  }
  const held = p => typeof isHeldFile === 'function' && typeof p === 'string' && !!isHeldFile(p, d);
  if (reason === 'duplicateOf') return held(d.duplicateOf) ? 'duplicate-of-held' : null;
  if (reason === 'crossOutletDuplicate') return d.crossOutletDuplicate === true && held(d.crossOutletPrimaryFile) ? 'cross-outlet-duplicate-of-held' : null;
  if (ENSEMBLE_EXCLUSION_REASONS.has(reason) && d.rejectedBy === 'ensemble-scoreability-check' && Number(d.rejectionAgreeCount) >= 3
    && ENSEMBLE_WRONG_REASONS.has(d.rejectionReason)) return 'ensemble-3-agree';
  return null;
}

/**
 * Classify one flaggedMiss from its excluded dir files.
 * @param {object[]} files - the excluded dir files for the listed URL
 * @param {(d: object) => (string|null)} [explain] - exclusion reason for a file
 *   (review-guards explainExclusion bound to the show); null/throw falls back
 *   to the raw detector field, then 'unknown' (for `basis` only)
 * @param {(pointer: string, d: object) => boolean} [isHeldFile] - does the pointer
 *   resolve to a held, counted file of d's owning show
 * @param {(url: string) => {isRoundup: boolean}} [isRoundupUrl] - review-guards isRoundupUrl
 * @returns {{ exclusion, basis: string[], confirmedNonReview: boolean, confirmedBasis: (string|null)[] }}
 */
function classifyFlaggedMiss(files, explain, isHeldFile, isRoundupUrl) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const human = list.some(hasHumanExclusionAssertion);
  const basis = [];
  const confirmedBasis = [];
  for (const d of list) {
    let reason = null;
    try { reason = explain ? explain(d) : null; } catch { reason = null; }
    const r = reason || rawDetectorBasis(d) || 'unknown';
    if (!basis.includes(r)) basis.push(r);
    confirmedBasis.push(isConfirmedNonReviewFile(d, isHeldFile) ? 'non-review'
      : ruleConfirmedBasis(d, reason, isHeldFile, isRoundupUrl));
  }
  // A human assertion normally means "never second-guess"; it only counts as a
  // confirmed non-review when the human said so (isNotReview), not e.g. wrongProduction.
  const confirmedNonReview = list.length > 0 && confirmedBasis.every(Boolean)
    && (!human || list.every(isHumanConfirmedNonReview));
  return { exclusion: human ? 'humanExcluded' : 'automatedExcluded', basis, confirmedNonReview, confirmedBasis };
}

// BRO-6716: exclusion reasons meaning "this file is a copy of another review".
const COPY_BASES = new Set(['duplicateOf', 'duplicateOfCircularTiebreak', 'isSyndicatedDuplicate',
  'knownSyndicationSecondary', 'crossOutletDuplicate', 'personalRepost']);

function normKeyPart(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function liveKey(outletId, criticName) {
  const o = normKeyPart(outletId), c = normKeyPart(criticName);
  return o && c && c !== 'unknown' ? `${o}|${c}` : null;
}

/**
 * BRO-6716 class H: a listed URL whose held file is excluded only as a COPY
 * (duplicateOf, syndicated reprint, known-syndication secondary, ...) is not a
 * gap when the review it copies is live. 9 of 9 such grade rows were live on
 * the site under the original (Chris Jones's Tribune review for the NY Daily
 * News reprint, the correctly spelled critic slot for a typo'd duplicate, ...),
 * yet each counted as a missing review.
 * @param {object[]} files - the excluded dir files for the listed URL
 * @param {string[]} basis - classifyFlaggedMiss basis for those files
 * @param {Set<string>} liveKeys - liveKey(outletId, criticName) of every
 *   reviews.json entry for the show (build with liveKeysFromReviews)
 * @param {(d: object) => object[]} [originalsOf] - the files this copy points
 *   at (duplicateOf target, syndication primary); each is tried as a live key
 * @returns {boolean}
 */
function isCopyOfLiveReview(files, basis, liveKeys, originalsOf) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length || !Array.isArray(basis) || !basis.length || !liveKeys || !liveKeys.size) return false;
  if (!basis.some(b => COPY_BASES.has(b))) return false;
  return list.some(d => {
    const cands = [d, ...((originalsOf && originalsOf(d)) || [])];
    return cands.some(x => x && liveKeys.has(liveKey(x.outletId || x.outlet, x.criticName)));
  });
}

/** Live keys for isCopyOfLiveReview from the show's reviews.json entries. */
function liveKeysFromReviews(reviews) {
  const keys = new Set();
  for (const r of reviews || []) {
    const k = r && liveKey(r.outletId || r.outlet, r.criticName);
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * BRO-6742: the flagged file's own url is already in reviews.json for this show.
 * The audit's per-file predicate (isIncludableForRebuild) is a mirror of the
 * rebuild with known gaps (e.g. a high-confidence CV not-a-review verdict that the
 * rebuild treats as advisory because the ensemble scored it as a review), and
 * where they disagree the rebuild wins. A review that is live is not a gap.
 * @param {object[]} files - the show-dir files for the cited host
 * @param {Set<string>} liveUrls - normalized urls of the show's reviews.json rows
 * @param {(u:string)=>string} norm - the same normalizer liveUrls was built with
 */
function isLiveItself(files, liveUrls, norm) {
  if (!liveUrls || !liveUrls.size || typeof norm !== 'function') return false;
  return (Array.isArray(files) ? files : []).some(d => d && typeof d.url === 'string' && d.url && liveUrls.has(norm(d.url)));
}

/** Re-check an automated exclusion only when a current-run round-up lists it. */
function shouldReverify(m) {
  return !!m && m.exclusion === 'automatedExcluded' && !m.confirmedNonReview && !m.copyOfLiveReview && !m.liveInReviews
    && !isPriorProductionCitation(m);
}

/** Count of flaggedMisses marked reverify (automated, current-run listed). */
function countAutomatedExcludedListed(flaggedMisses) {
  return Array.isArray(flaggedMisses) ? flaggedMisses.filter(m => m && m.reverify === true).length : 0;
}

/**
 * Build the isHeldFile callback for classifyFlaggedMiss over one show dir's files.
 * A pointer ('<show>/<file>' or bare '<file>') resolves against the file's OWNING show
 * (_ctxShow, else _carriedFromShowId, else the host show), so a carried file's bare
 * pointer never matches a same-named file of the host show. The target must be another
 * file of the same owner that isCovered says is counted.
 */
function makeHeldFileResolver(dirData, hostShowId, isCovered) {
  const ownerOf = x => (x._ctxShow && x._ctxShow.id) || x._carriedFromShowId || hostShowId;
  return (pointer, d) => {
    const p = parsePointer(pointer);
    if (!p) return false;
    const owner = ownerOf(d);
    if ((p.showId || owner) !== owner) return false;
    return dirData.some(x => x !== d && x._file === p.file && ownerOf(x) === owner && isCovered(x));
  };
}

module.exports = {
  makeHeldFileResolver,
  hasHumanExclusionAssertion,
  rawDetectorBasis,
  classifyFlaggedMiss,
  isConfirmedNonReviewFile,
  hasReviewShapedEvidence,
  shouldReverify,
  isLiveItself,
  countAutomatedExcludedListed,
  isCopyOfLiveReview,
  liveKeysFromReviews,
};
