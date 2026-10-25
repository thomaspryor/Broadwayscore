/**
 * Guarded field-merge for review-file consolidation passes.
 *
 * The rebuild's stale-filename cleanup passes (--unknown rename, outlet-prefix
 * mismatch) merge "unique fields" from a mis-named file into its canonical
 * sibling, then delete the source. Blind copying is a contamination vector:
 * on 2026-07-12 a not_a_review-flagged interview stub was folded into a live
 * scored star row (my-neighbour-totoro theupcoming), transferring
 * rejectionReason + the interview URL — the legit review silently dropped out
 * of reviews.json (Notion 39b637c5-416f-815e).
 *
 * Rules:
 *  1. An exclusion-flagged source NEVER merges — callers must leave the source
 *     file in place (inert tombstone; the validator skips flagged files, so a
 *     tombstone sharing outlet+critic with its canonical sibling is not an
 *     error). Applies regardless of the target's own flag state: transferring
 *     url/text out of an excluded file can resurrect a target through the
 *     URL-token-driven stale-flag self-heals.
 *  2. Flag, pointer, verdict, and operator-decision fields never transfer in
 *     any merge — they describe the file they sit on, not the sibling.
 *  3. A source carrying an operator assertion (a human cleared or pinned it)
 *     is never deleted either. Rule 2 means its protection cannot move to the
 *     sibling, so unlinking it silently undid the human decision: 2026-09-27
 *     Catarina / London Unattached was hand-cleared, merged away as a stale
 *     --unknown file, and the unprotected sibling was CV-promoted again
 *     (BRO-4185 follow-up). Callers treat any action other than 'merged' as
 *     "leave the source file in place".
 *
 * isExclusionFlagged mirrors the data-only flag checks of the canonical
 * predicate review-guards.js::isIncludableForRebuild (which cannot be called
 * here: it needs show/filePath context and excludes even clean fixtures
 * without it). Drift is enforced by tests/unit/merge-review-fields.test.mjs,
 * which parses isIncludableForRebuild's source and asserts every `data.<flag>`
 * exclusion it gates on is covered below. Deliberately conservative: the
 * stale-flag self-heal overrides (isLikelyStale*) are ignored — a skipped
 * merge just leaves a file in place.
 */

const { wrongShowCleared, isFullTextWrongAuthorActive } = require('./review-guards');
const { absorbMergedDuplicates } = require('./merged-duplicate-urls');
const { canonicalReviewUrl } = require('./review-url-clusters');

// Field families that never transfer between review files.
const NEVER_TRANSFER_PATTERN = new RegExp(
  '^(' + [
    'wrong',                 // wrongProduction*, wrongShow*, wrongUrl, wrongAttribution, ...
    'reject',                // rejectionReason/Reasoning, rejectedBy/At
    'duplicate',             // duplicateOf/Reason/TextOf/ClearReason
    'suspectedMisattribution',
    'isRoundup', 'roundup',
    'isNonReview', 'isNotReview', 'nonReview',
    'fabricatedEntry',
    'fullTextWrongAuthor',
    'isSyndicated',
    'crossOutletDuplicate',
    'bwwAggregatorAmbiguous',
    'contentVerification',   // CV verdict describes the file's own body
    'flaggedForReview', 'flagReason',
    'incompleteReason', 'incompleteDetail', // describe the source's own content state
    'manualContentTier', 'humanReview',     // operator decisions about THAT file
    'allowEarlyDate', 'allowCrossMarket',
    'allowTourSignal', 'allowFilmSignal', // (+Reason) judged on THAT file's fullText
    'allowSignalHistory',
    '_locked',
    // History of edits made to THAT file (BRO-5130, review-texts bf5fa64a0):
    // copied onto the sibling they claimed fixes/clears it never received.
    'approvedFixes',
    '_urlChangedClear',
    'previousUrl',
    'urlCorrectedFrom',
  ].join('|') + ')'
);

// Fields whose presence records a human decision about THIS file. One list,
// so a new override family is added here once rather than in each consumer.
const OPERATOR_ASSERTION_FIELDS = [
  'wrongProductionManualClear', 'wrongArticleManualClear', 'wrongShowManualClear',
  'wrongProductionOverride', 'wrongShowOverride', 'isNotReviewManualClear',
  'manualContentTier', 'humanReviewScore',
  'allowEarlyDate', 'allowCrossMarket', 'allowTourSignal', 'allowFilmSignal',
  'manualClearNote', 'nonReviewManualClear',
];

// Any *ManualClear breadcrumb is a person's decision about THIS file, named or
// not. BRO-5130: nonReviewManualClear was missing from the list above, so a
// person's "this is a review" file was merged into a stale wrongShow sibling
// and deleted (review-texts bf5fa64a0). A pattern, so the next new clear family
// cannot drift out of the list again. *Override is NOT matched by pattern:
// automation writes nonReviewOverride ("Auto-recovered: ...") and
// textQualityOverride (batch fixes); human *Override names are listed above.
const OPERATOR_ASSERTION_KEY_PATTERN = /ManualClear$/;

function _isSet(v) {
  return v != null && v !== false && v !== '';
}

function hasOperatorAssertion(data) {
  if (!data) return false;
  if (data.humanReviewedWrongProduction === false) return true;
  if (OPERATOR_ASSERTION_FIELDS.some(k => _isSet(data[k]))) return true;
  return Object.keys(data).some(k => OPERATOR_ASSERTION_KEY_PATTERN.test(k) && _isSet(data[k]));
}

// The fetched-text block: these describe ONE body of text and move together.
// Copying fullText alone left the stale contentTier/tierReason of the old
// body on the target, so the review still never scored (BRO-4447).
const FETCHED_TEXT_STATE_FIELDS = [
  'fullText', 'textWordCount', 'wordCount', 'contentTier', 'contentTierReason',
  'tierReason', 'textFetchedAt', 'collectedAt', 'fetchMethod', 'fetchTier',
  'textStatus', 'textQuality', 'isFullReview', 'truncationSignals', 'textIssues',
  'incompleteReason', 'incompleteDetail',
];
// Verdicts computed from the target's OLD body; wrong once the body changes.
const STALE_TEXT_VERDICT_FIELDS = [
  'rescoreBlockedReason', 'rescoreBlockedAt', 'rescoreBlockedHadExcerpt',
  'rescoreBlockedTextLength', 'needsFullText', 'needsRefetch',
];
const MIN_ADOPTED_TEXT_CHARS = 200;
const UNUSABLE_TEXT_TIERS = new Set(['invalid', 'stub']);

function _textLength(d) {
  return d && typeof d.fullText === 'string' ? d.fullText.trim().length : 0;
}

/**
 * BRO-4447: a rebuild from a stale checkout renamed outlet--unknown.json to
 * outlet--critic.json BEFORE the text fetch landed, so the named target holds
 * the old textless body and the --unknown source holds the fetched review.
 * The fill-only merge kept the target's stale text state and the caller then
 * deleted the source, losing the text. When both files are the same review
 * (same canonical url on both) and the source's text is substantially
 * longer, usable and no older than the target's, the source's whole text block replaces the target's.
 * A target a person pinned (_locked, manualContentTier) keeps its text.
 * Mutates target; returns true when it adopted the source's text.
 */
function adoptNewerFetchedText(target, source) {
  if (!target || !source) return false;
  if (target._locked === true || _isSet(target.manualContentTier)) return false;
  // Both files must name the same review. An empty url proves nothing: the
  // rebuild pairs files by critic filename, so it could be another review.
  if (!target.url || !source.url) return false;
  if (canonicalReviewUrl(target.url) !== canonicalReviewUrl(source.url)) return false;
  const srcLen = _textLength(source);
  if (srcLen < MIN_ADOPTED_TEXT_CHARS) return false;
  if (_textLength(target) >= srcLen * 0.8) return false;
  // Longer is not better when the longer body is junk (paywall, roundup,
  // wrong article) or older than the target's own fetch (a deliberate trim).
  if (UNUSABLE_TEXT_TIERS.has(source.contentTier)) return false;
  if (source.contentVerification && source.contentVerification.wrongArticle === true) return false;
  if (source.isRoundupArticle === true || source.isNonReview === true) return false;
  const srcAt = Date.parse(source.textFetchedAt || '');
  const tgtAt = Date.parse(target.textFetchedAt || '');
  if (Number.isFinite(srcAt) && Number.isFinite(tgtAt) && srcAt < tgtAt) return false;
  for (const key of FETCHED_TEXT_STATE_FIELDS) {
    if (source[key] != null) target[key] = source[key];
    else delete target[key];
  }
  // The CV verdict describes a body of text: take the source's, or drop the
  // target's, which was about the body just replaced.
  if (source.contentVerification) target.contentVerification = source.contentVerification;
  else delete target.contentVerification;
  for (const key of STALE_TEXT_VERDICT_FIELDS) delete target[key];
  require('./rescore-flagging').markRescoreNeeded(target, 'fullText adopted from merged same-url sibling (BRO-4447)', undefined, { requeue: true });
  return true;
}

function isTransferableField(key) {
  return !NEVER_TRANSFER_PATTERN.test(key);
}

function _wrongProductionCleared(d) {
  return d.wrongProductionManualClear === true ||
    d.wrongProductionOverride === true ||
    d.humanReviewedWrongProduction === false;
}

function isExclusionFlagged(data) {
  if (!data) return false;
  if (data.wrongProduction === true && !_wrongProductionCleared(data)) return true;
  if (data.wrongShow === true && !wrongShowCleared(data)) return true;
  if (data.wrongAttribution === true) return true;
  if (data.duplicateOf || data.duplicateTextOf) return true;
  if (data.isRoundupArticle === true) return true;
  if (
    data.isNonReview === true || data.isNotReview === true ||
    data.nonReviewFlag === true || data.nonReviewContent === true
  ) return true;
  if (data.fabricatedEntry === true) return true;
  if (isFullTextWrongAuthorActive(data)) return true;
  if (data.isSyndicatedDuplicate === true) return true;
  if (data.crossOutletDuplicate === true) return true;
  if (data.bwwAggregatorAmbiguous === true && !data.bwwAggregatorAmbiguousClearedNote) return true;
  if (data.suspectedMisattribution === true) return true;
  if (data.contentVerification && data.contentVerification.wrongArticle === true &&
      data.contentVerification.confidence === 'high') return true;
  if (data.rejectionReason) return true;
  if (data.rejectedBy && Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) return true;
  if (data.rejectedAt && typeof data.rejectedAt === 'string') return true;
  return false;
}

/**
 * Merge source's fields into target (mutating target) where target lacks them
 * (null/undefined; explicit false/0/'' on the target are preserved).
 *
 * @returns {{ action: 'merged'|'skip-flagged-source'|'skip-protected-source', changed: boolean }}
 *   Any action other than 'merged' → target untouched; caller must NOT delete the source.
 */
function mergeUniqueReviewFields(target, source) {
  if (isExclusionFlagged(source)) {
    return { action: 'skip-flagged-source', changed: false };
  }
  if (hasOperatorAssertion(source)) {
    return { action: 'skip-protected-source', changed: false };
  }
  let changed = adoptNewerFetchedText(target, source);
  for (const [key, val] of Object.entries(source || {})) {
    if (!isTransferableField(key)) continue;
    if (val != null && target[key] == null) {
      target[key] = val;
      changed = true;
    }
  }
  // BRO-4414: the source file is about to be deleted by the caller; its URL must
  // outlive it or the next writer pass re-adopts it and wipes this target.
  if (absorbMergedDuplicates(target, source)) changed = true;
  return { action: 'merged', changed };
}

module.exports = {
  mergeUniqueReviewFields,
  adoptNewerFetchedText,
  FETCHED_TEXT_STATE_FIELDS,
  isExclusionFlagged,
  isTransferableField,
  hasOperatorAssertion,
  OPERATOR_ASSERTION_FIELDS,
  OPERATOR_ASSERTION_KEY_PATTERN,
  NEVER_TRANSFER_PATTERN,
};
