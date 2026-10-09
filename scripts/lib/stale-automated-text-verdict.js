'use strict';

/**
 * stale-automated-text-verdict.js — an automated TEXT-QUALITY verdict
 * (not_a_review / garbage_text / truncated_text, or the heuristic+llm
 * nonReviewFlag) judges the body that was on disk when it ran. When a later
 * fetch replaced that body with a complete article, the verdict describes text
 * that no longer exists, yet it keeps excluding the review: review-guards.js
 * returns 'rejectionReason' / nonReviewFlag regardless of textFetchedAt, and
 * the LLM scorer skips the file for the same reason, so nothing re-judges it.
 *
 * Found 2026-09-29: 56 files with >=1500-char fullText fetched AFTER an
 * ensemble-scoreability-check rejection or heuristic+llm nonReviewFlag, e.g.
 * a-time-to-kill-2013/nytimes--charles-isherwood.json (garbage_text on an
 * old paywall scrape, real Isherwood review on disk now). The writers that
 * put the new text in (recover-*-browser.js fs.writeFileSync,
 * collect-review-texts.js, llm-scoring saveReviewFile) do not all go through
 * safeWriteReview, so the fix is a corpus sweep on this predicate
 * (scripts/clear-stale-automated-text-verdicts.js), not a write hook.
 *
 * The clear does NOT assert the review is genuine. It moves the verdict aside
 * into a breadcrumb, parks every score computed from the OLD text (so nothing
 * publishes until the scorer re-judges the new body) and hands the file back
 * to the normal LLM scorer, which re-rejects it (with a fresh rejectedAt newer
 * than textFetchedAt, so this predicate stops matching — no loop) when the new
 * text is junk too.
 *
 * Deliberately NOT matched by the text-quality predicate:
 *   - wrong_production / wrong_show: a re-fetch of the same URL does not
 *     refute a verdict about WHICH production/show the article covers. (A
 *     wrong_production verdict issued WITHOUT the show's declared earlier
 *     runs/tour legs in the prompt IS re-checked, by the separate
 *     isPreContextWrongProduction predicate below, BRO-4391.)
 *   - human verdicts: manual-* / human-* / audit-* rejectedBy, isNotReview,
 *     isNonReview, humanReviewScore, manualContentTier, _locked, and
 *     contradicted-flag-basis.js's hasHumanAssertedFlag.
 *
 * Pure: no fs, no process.
 */

const { hasHumanAssertedFlag } = require('./contradicted-flag-basis');
const { isTimestampAfter } = require('./review-guards');
const { findMatchingPriorRun, isWithinTourLeg } = require('./wrong-production-autoclear');
const { clearWrongProductionFlags } = require('./wrong-production-clear');

const TEXT_QUALITY_REASONS = new Set(['not_a_review', 'garbage_text', 'truncated_text']);
const AUTOMATED_REJECTERS = new Set(['ensemble-scoreability-check', 'news-article-heuristic-check', 'preopening-interview-signal']);
const AUTOMATED_NONREVIEW_METHODS = new Set(['heuristic+llm']);
const COMPLETE_TEXT_MIN = 1500;
// Tiers that say the body on disk is not a real article, whatever its length.
const NON_COMPLETE_TIERS = new Set(['invalid', 'stub', 'excerpt']);

const REJECTION_FIELDS = ['rejectionReason', 'rejectedAt', 'rejectedBy', 'rejectionReasoning'];
const NONREVIEW_FIELDS = ['nonReviewFlag', 'nonReviewType', 'nonReviewEvidence', 'nonReviewFlaggedAt', 'nonReviewMethod'];
const RECHECK_RESCORE_REASON = 'wrong_production verdict predates declared runs/tour legs in the scoring prompt (re-check with runs context)';
const RESCORE_REASON = 'stale automated text verdict cleared (fullText re-fetched after rejection)';

// undefined/null rejectedBy is NOT automated: 451 corpus rejections carry a
// free-text reason with no rejectedBy, and those were written by hand.
function isAutomatedRejecter(rejectedBy) {
  if (typeof rejectedBy !== 'string') return false;
  return AUTOMATED_REJECTERS.has(rejectedBy) || rejectedBy.startsWith('blocked-url-');
}

// rejectedBy values a person (or an operator-run triage) wrote: manual-triage-bro-71,
// human-manual-cleanup, audit-unknown-outlets-triage, manual-contamination-triage, ...
function isHumanRejecter(rejectedBy) {
  return typeof rejectedBy === 'string' && /^(manual|human|audit)[-_]/i.test(rejectedBy);
}

function hasCompleteText(d) {
  if (typeof d.fullText !== 'string' || d.fullText.trim().length < COMPLETE_TEXT_MIN) return false;
  return !NON_COMPLETE_TIERS.has(d.contentTier);
}

function hasHumanVerdict(d) {
  if (d._locked) return true;
  if (d.humanReviewScore != null) return true;
  if (d.manualContentTier != null) return true;
  if (d.isNotReview === true) return true;
  // isNonReview is a separate exclusion this sweep does not clear; leaving the
  // file matched would requeue something that stays excluded (stuck flag).
  if (d.isNonReview === true) return true;
  if (hasHumanAssertedFlag(d)) return true;
  return false;
}

/** An automated text-quality rejection (reason + rejecter), regardless of timing. */
function isAutomatedTextRejection(d) {
  return !!d && TEXT_QUALITY_REASONS.has(d.rejectionReason) && isAutomatedRejecter(d.rejectedBy);
}

/**
 * Which stale automated text verdicts the record carries.
 *
 * @param {object} d - review record
 * @returns {Array<'rejection'|'nonReview'>} empty when nothing is stale-and-clearable
 */
function staleAutomatedTextVerdicts(d) {
  if (!d || typeof d !== 'object') return [];
  if (!hasCompleteText(d) || !d.textFetchedAt) return [];
  if (hasHumanVerdict(d)) return [];
  // A live rejection we must NOT clear (wrong_production, a human's, a fresh
  // one) keeps the file excluded anyway; clearing a sibling nonReviewFlag
  // underneath it would only requeue a dead file. A null rejectionReason with
  // a leftover rejectedBy/rejectedAt (BRO-79 residue) is not a live verdict.
  const hasRejection = d.rejectionReason != null;
  const rejectionStale = hasRejection &&
    isAutomatedTextRejection(d) &&
    isTimestampAfter(d.textFetchedAt, d.rejectedAt);
  const nonReviewStale = d.nonReviewFlag === true &&
    AUTOMATED_NONREVIEW_METHODS.has(d.nonReviewMethod) &&
    isTimestampAfter(d.textFetchedAt, d.nonReviewFlaggedAt);
  if (hasRejection && !rejectionStale) return [];
  if (d.nonReviewFlag === true && !nonReviewStale) return [];
  const out = [];
  if (rejectionStale) out.push('rejection');
  if (nonReviewStale) out.push('nonReview');
  return out;
}

/** True iff the record carries at least one stale, clearable automated text verdict. */
function isStaleAutomatedTextVerdict(d) {
  return staleAutomatedTextVerdicts(d).length > 0;
}

// Score sources computed from the review's TEXT (LLM ensemble/anchored, the
// older keyword sentiment pass) — or unlabelled. These were scored on the body
// the stale verdict rejected, so they must not publish once the verdict goes.
// Anything else (guardian-api, *-svg-stars, *-star-rating, lbo-css-stars, ...)
// is an outlet's own rating and stays.
function isTextDerivedScoreSource(scoreSource) {
  if (scoreSource == null) return true;
  return /^(llm|ensemble|anchored-v6|sentiment)/.test(String(scoreSource));
}

/**
 * Park every score computed from the old text (pattern: fix-garbage-scores.js
 * invalidateScore). llmScore / ensembleData / adjudicatedScore always go; a
 * text-derived assignedScore goes too, replaced by originalScoreNormalized
 * when the outlet published an explicit rating. Stamps the
 * staleTextVerdictScoreParked(+At) breadcrumb so safeWriteReview and the
 * push-review-texts restore honor the null instead of resurrecting the old
 * score from disk (review-write-guard.js CLEAR_BREADCRUMBS). Mutates.
 *
 * @returns {object|null} the parked values, or null when nothing was parked
 */
function parkTextDerivedScore(d, at) {
  const parked = {};
  for (const f of ['llmScore', 'ensembleData', 'adjudicatedScore']) {
    if (d[f] != null) { parked[f] = d[f]; d[f] = null; }
  }
  if (isTextDerivedScoreSource(d.scoreSource)) {
    for (const f of ['assignedScore', 'bucket', 'scoreSource']) {
      if (d[f] != null) { parked[f] = d[f]; d[f] = null; }
    }
    if (typeof d.originalScoreNormalized === 'number' && Number.isFinite(d.originalScoreNormalized)) {
      d.assignedScore = d.originalScoreNormalized;
      d.scoreSource = 'explicit-after-stale-verdict-clear';
    }
  }
  if (!Object.keys(parked).length) return null;
  d.staleTextVerdictScoreParked = true;
  d.staleTextVerdictScoreParkedAt = at;
  return parked;
}

function _clearInto(d, fields, prior) {
  for (const f of fields) {
    if (d[f] != null) prior[f] = d[f];
    d[f] = null;
  }
}

function _pushBreadcrumb(d, prior) {
  const history = Array.isArray(d.priorAutomatedTextVerdicts) ? d.priorAutomatedTextVerdicts : [];
  d.priorAutomatedTextVerdicts = [...history, prior];
}

function _markRescore(d, at) {
  // Lazy: rescore-flagging → is-scoreable → review-guards; keep this module's
  // load light for collect-review-texts.js.
  require('./rescore-flagging').markRescoreNeeded(d, RESCORE_REASON, at);
}

/**
 * Move the stale verdict(s) aside, null-assign the live fields (never
 * delete — push-review-texts' restore resurrects deleted fields) and park the
 * old-text score. Does NOT raise needsRescore — the sweep decides that after
 * checking isScoreable. Mutates.
 *
 * @param {object} d
 * @param {string} [now] - ISO timestamp (injectable for tests)
 * @returns {Array<string>} the kinds cleared ([] = no-op)
 */
function neutralizeStaleAutomatedTextVerdict(d, now) {
  const kinds = staleAutomatedTextVerdicts(d);
  if (!kinds.length) return kinds;
  const at = now || new Date().toISOString();
  const prior = { clearedAt: at, clearedBy: 'stale-automated-text-verdict', textFetchedAt: d.textFetchedAt };
  if (kinds.includes('rejection')) _clearInto(d, REJECTION_FIELDS, prior);
  if (kinds.includes('nonReview')) _clearInto(d, NONREVIEW_FIELDS, prior);
  const parked = parkTextDerivedScore(d, at);
  if (parked) prior.parkedScore = parked;
  _pushBreadcrumb(d, prior);
  return kinds;
}

/**
 * BRO-4391: an automated wrong_production rejection on a review dated inside
 * one of the show's DECLARED priorRuns/tourLegs windows, never re-judged with
 * that runs context. The ensemble rejected these (The Car Man at Curve
 * Leicester, 2026-08-03) before tourLegs reached the prompt (BRO-4154/4148) or
 * before the priorRuns were declared; audit-autoclear-vs-ensemble then restored
 * wrongProduction from the "unanimous" pre-context verdict, so a real review
 * stayed excluded forever. One re-check per file: productionVerdictRecheckedAt
 * (PROTECTED_FIELDS) retires the predicate, and a re-rejection WITH context
 * stands.
 *
 * @param {object} d - review record
 * @param {object} show - shows.json entry (priorRuns / tourLegs)
 */
function isPreContextWrongProduction(d, show) {
  if (!d || !show || typeof d !== 'object') return false;
  if (d.rejectionReason !== 'wrong_production' || d.rejectedBy !== 'ensemble-scoreability-check') return false;
  if (d.productionVerdictRecheckedAt) return false;
  if (!d.publishDate) return false;
  // A body too short to judge cannot be re-scored into a different verdict.
  if (typeof d.fullText !== 'string' || d.fullText.trim().length < COMPLETE_TEXT_MIN) return false;
  if (hasHumanVerdict(d)) return false;
  if (d.wrongProductionManualClear === true || d.wrongProductionOverride === true ||
      d.humanReviewedWrongProduction != null || d.wrongShow === true || d.duplicateOf) return false;
  return !!findMatchingPriorRun(d.publishDate, show.priorRuns) || isWithinTourLeg(d.publishDate, show.tourLegs);
}

/**
 * Clear a pre-context wrong_production verdict + flag, park the score from
 * that verdict, stamp productionVerdictRecheckedAt, breadcrumb it. Does NOT
 * raise needsRescore (the sweep checks isScoreable first). Mutates.
 *
 * @returns {boolean} true when cleared
 */
function neutralizePreContextWrongProduction(d, show, now) {
  if (!isPreContextWrongProduction(d, show)) return false;
  const at = now || new Date().toISOString();
  const prior = {
    clearedAt: at, clearedBy: 'pre-context-wrong-production-recheck', textFetchedAt: d.textFetchedAt,
    wrongProduction: d.wrongProduction ?? null, rejectionAgreeCount: d.rejectionAgreeCount ?? null,
  };
  _clearInto(d, REJECTION_FIELDS, prior);
  if (d.promptVersion != null) { prior.promptVersion = d.promptVersion; d.promptVersion = null; }
  // noOverrideStamp: this is a re-judge request, not a human "genuine" verdict;
  // wrongProductionOverride would exempt the file from every later guard.
  clearWrongProductionFlags(d, { source: 'pre-context-wrong-production-recheck', reason: 'ensemble wrong_production verdict predates declared runs/tour legs (BRO-4391)', noOverrideStamp: true });
  delete d.wrongProductionRestoredNote;
  const parked = parkTextDerivedScore(d, at);
  if (parked) prior.parkedScore = parked;
  d.productionVerdictRecheckedAt = at;
  _pushBreadcrumb(d, prior);
  return true;
}

/**
 * collect-review-texts.js re-fetch path: the file just got a fresh body, so an
 * automated text-quality rejection of the OLD body is void. Clears it, parks
 * the old-text score and requeues the file. Leaves wrong_production /
 * wrong_show, human rejections and rejections with no rejectedBy untouched.
 * Mutates.
 *
 * @returns {boolean} true when a rejection was cleared
 */
function clearAutomatedTextRejectionOnRefetch(d, now) {
  if (!d || !isAutomatedTextRejection(d) || hasHumanVerdict(d)) return false;
  const at = now || new Date().toISOString();
  const prior = { clearedAt: at, clearedBy: 'collect-review-texts-refetch' };
  _clearInto(d, REJECTION_FIELDS, prior);
  if (d.promptVersion != null) { prior.promptVersion = d.promptVersion; d.promptVersion = null; }
  const parked = parkTextDerivedScore(d, at);
  if (parked) prior.parkedScore = parked;
  _pushBreadcrumb(d, prior);
  _markRescore(d, at);
  return true;
}

module.exports = {
  isHumanRejecter,
  isAutomatedRejecter,
  isAutomatedTextRejection,
  isStaleAutomatedTextVerdict,
  staleAutomatedTextVerdicts,
  neutralizeStaleAutomatedTextVerdict,
  clearAutomatedTextRejectionOnRefetch,
  isPreContextWrongProduction,
  neutralizePreContextWrongProduction,
  parkTextDerivedScore,
  isTextDerivedScoreSource,
  TEXT_QUALITY_REASONS,
  COMPLETE_TEXT_MIN,
  RESCORE_REASON,
  RECHECK_RESCORE_REASON,
};
