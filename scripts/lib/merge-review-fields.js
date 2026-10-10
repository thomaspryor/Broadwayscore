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

const { wrongShowCleared } = require('./review-guards');
const { absorbMergedDuplicates } = require('./merged-duplicate-urls');

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
  ].join('|') + ')'
);

// Fields whose presence records a human decision about THIS file. One list,
// so a new override family is added here once rather than in each consumer.
const OPERATOR_ASSERTION_FIELDS = [
  'wrongProductionManualClear', 'wrongArticleManualClear', 'wrongShowManualClear',
  'wrongProductionOverride', 'wrongShowOverride', 'isNotReviewManualClear',
  'manualContentTier', 'humanReviewScore',
  'allowEarlyDate', 'allowCrossMarket', 'allowTourSignal', 'allowFilmSignal',
  'manualClearNote',
];

function hasOperatorAssertion(data) {
  if (!data) return false;
  if (data.humanReviewedWrongProduction === false) return true;
  return OPERATOR_ASSERTION_FIELDS.some(k => data[k] != null && data[k] !== false && data[k] !== '');
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
  if (data.fullTextWrongAuthor === true) return true;
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
  let changed = false;
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
  isExclusionFlagged,
  isTransferableField,
  hasOperatorAssertion,
  OPERATOR_ASSERTION_FIELDS,
  NEVER_TRANSFER_PATTERN,
};
