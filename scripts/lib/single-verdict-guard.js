'use strict';
/**
 * BRO-7050: one classifier verdict must not hide a review the aggregators list
 * or the scorer already scored from full text.
 *
 * Pure (no I/O, no review-guards import). review-guards.js calls it from the
 * same three vetoes that already carry the in-window rule (cvFlagVetoedInWindow,
 * isNonReviewDemotedByFreshCV, isRejectedByReasonExclusion), so the rebuild,
 * explainExclusion and scoring-delta.js all see one answer.
 *
 * A "hold" means: treat the stored flag as advisory at inclusion time. The flag
 * stays on disk; nothing is cleared. It applies only when
 *   1. the file has independent evidence it is a review of this production:
 *      an aggregator lists it (excerpt or url field), or (ensemble rejections
 *      only) the scorer scored it from >= 500 chars of full text, and
 *   2. exactly one automated classifier family produced every active verdict
 *      (a second family agreeing, or any hard/human/rule signal, means no hold).
 */

const { EXCERPT_FIELDS } = require('./excerpt-fields');

// metaExcerpt is the review page's own headline, not an aggregator listing.
const AGGREGATOR_EXCERPT_FIELDS = EXCERPT_FIELDS.filter((f) => f !== 'metaExcerpt');
const MIN_FULLTEXT_CHARS = 500;

const KINDS = ['nonReview', 'wrongProduction', 'wrongShow', 'rejection'];

const norm = (t) => String(t || '').toLowerCase().replace(/&#0?38;|&amp;/g, '&').replace(/[\u2018\u2019\u201c\u201d]/g, "'").replace(/[^a-z0-9&']+/g, ' ').trim();

/**
 * Aggregator excerpt fields whose quote actually appears in THIS file's body. An aggregator lists a
 * critic+outlet+show, not a URL, so a bare excerpt can belong to a different piece by the same critic
 * (2026-11-06 hand-check: a Times review's excerpt sat on a file holding the same critic's interview, and a
 * Noughts & Crosses review's excerpts sat on a Romeo and Juliet file). A quote found in the body proves the
 * listing is of this text. The show-level roundup/url fields prove nothing about one file and are not used.
 */
function aggregatorListedBy(data) {
  if (!data || typeof data.fullText !== 'string' || data.fullText.length < 200) return [];
  const body = norm(data.fullText);
  return AGGREGATOR_EXCERPT_FIELDS.filter((f) => {
    if (typeof data[f] !== 'string' || !data[f]) return false;
    return data[f].split(/\s*(?:…|\.{3})\s*/).map(norm).some((seg) => seg.length >= 25 && body.includes(seg));
  });
}

/** True when an llm score exists and was read from real full text. */
function scoredFromFullText(data) {
  if (!data) return false;
  return /^llm/i.test(String(data.scoreSource || ''))
    && Number.isFinite(data.assignedScore)
    && typeof data.fullText === 'string'
    && data.fullText.length >= MIN_FULLTEXT_CHARS;
}

// The ensemble's rejection text lists one "<model>: <reasoning>" voice per model that agreed.
function ensembleVoices(data) {
  const voices = new Set(String(data.rejectionReasoning || '').match(/(?:^|;\s*)(claude|openai|gemini|gpt|kimi)\s*:/gi) || []);
  return Math.max(voices.size, Number.isFinite(data.rejectionAgreeCount) ? data.rejectionAgreeCount : 0);
}

// An ensemble rejection is a consensus of several models (2026-11-06 hand-check: every multi-model
// rejection in the sweep was right: an interview, a critics roundup, a different show). Only a rejection
// a single model carried is one classifier verdict.
function soloEnsembleRejected(data) {
  const by = data.rejectedBy;
  const names = Array.isArray(by) ? by : (by ? [by] : []);
  return !!data.rejectionReason && names.length > 0
    && names.every((n) => /ensemble/i.test(String(n)))
    && ensembleVoices(data) <= 1;
}

function humanOrHardSignal(data) {
  return !!(data.manualReviewedBy || data.manualNonReviewSet === true || data.manualNonReviewBy
    || data.humanReviewedWrongProduction === true || data.humanReviewedWrongShow === true
    || data.wrongProductionNote || data.wrongShowNote
    || data.isNotReview === true || data.nonReviewFlag === true || data.nonReviewContent === true
    || data.wrongAttribution === true || data.fabricatedEntry === true
    || data.incompleteReason === 'wrong_content' || data.contentTier === 'invalid'
    || (typeof data.isNonReviewReason === 'string' && /^manual \(not a review\)/i.test(data.isNonReviewReason)));
}

/**
 * Classifier families that currently back an exclusion verdict on this file.
 * Unrecognised sources are NOT listed: they make `unknownSource` true so the
 * caller never holds on a verdict it cannot name.
 */
function activeClassifierFamilies(data, ctx = {}) {
  const families = new Set();
  let unknownSource = false;
  if (data.isNonReview === true) {
    if (data.nonReviewClassifiedBy === 'gemini') families.add('gemini');
    else if (/^CV-promoted\b/.test(String(data.isNonReviewReason || ''))) families.add('cv');
    else unknownSource = true;
  }
  if (data.wrongProduction === true) {
    if (/^classify-wrong-production/.test(String(data.wrongProductionDetectedBy || ''))) families.add('wp-classifier');
    else if (!data.wrongProductionDetectedBy && (/^CV-promoted\b/.test(String(data.wrongProductionReason || ''))
      || data.llmClassified === 'wrongProduction')) families.add('cv');
    else unknownSource = true;
  }
  if (data.wrongShow === true) {
    if (/^(?:CV-promoted\b|LLM\b)/.test(String(data.wrongShowReason || ''))) families.add('cv');
    else unknownSource = true;
  }
  if (data.rejectionReason) {
    if (soloEnsembleRejected(data)) families.add('ensemble');
    else unknownSource = true;
  }
  if (ctx.cvStands === true) families.add('cv');
  return { families, unknownSource };
}

/**
 * @param {object} data review-text JSON
 * @param {'nonReview'|'wrongProduction'|'wrongShow'|'rejection'} kind the verdict being asked about
 * @param {object} [ctx]
 * @param {boolean} [ctx.cvStands] a current high-confidence CV verdict affirms the flag (a second family)
 * @returns {{held:boolean, reason:string, families:string[], listedBy:string[], scored:boolean}}
 */
function evaluateSoloVerdictHold(data, kind, ctx = {}) {
  const no = (reason, extra = {}) => ({ held: false, reason, families: [], listedBy: [], scored: false, ...extra });
  if (process.env.SINGLE_VERDICT_GUARD_DISABLED === '1') return no('kill-switch');
  if (!data || !KINDS.includes(kind)) return no('not-applicable');
  const flagPresent = kind === 'nonReview' ? data.isNonReview === true
    : kind === 'wrongProduction' ? data.wrongProduction === true
      : kind === 'wrongShow' ? data.wrongShow === true
        : !!data.rejectionReason;
  if (!flagPresent) return no('no-flag');
  if (humanOrHardSignal(data)) return no('hard-or-human-signal');
  const { families, unknownSource } = activeClassifierFamilies(data, ctx);
  if (unknownSource) return no('unknown-source');
  if (families.size !== 1) return no(families.size === 0 ? 'no-family' : 'second-family-agrees', { families: [...families] });
  const listedBy = aggregatorListedBy(data);
  const scored = scoredFromFullText(data);
  // A score proves the scorer read the text, not that the text is a review: the scorer rates any article, and the
  // 2026-11-06 hand-check of a score-only nonReview hold restored a Vanity Fair profile, a Vogue interview and a
  // New Yorker feature. So for nonReview/wrong-production/show verdicts only an aggregator listing counts; a
  // full-text score is evidence solely against an ensemble rejection (the ensemble contradicting the scorer).
  // An ensemble rejection of a listed review with no score at all (Paddington/standard: an interview the
  // ShowScore page also lists) restores nothing countable, so a listing alone needs a score beside it.
  const scoreCounts = scored && kind === 'rejection';
  const listedScoreOk = kind !== 'rejection' || Number.isFinite(data.assignedScore);
  if (!(listedBy.length && listedScoreOk) && !scoreCounts) return no('no-independent-evidence', { families: [...families] });
  return { held: true, reason: 'solo-classifier-verdict', families: [...families], listedBy, scored };
}

module.exports = {
  evaluateSoloVerdictHold,
  aggregatorListedBy,
  scoredFromFullText,
  activeClassifierFamilies,
};
