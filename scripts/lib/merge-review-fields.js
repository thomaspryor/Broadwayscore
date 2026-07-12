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
 *  1. An exclusion-flagged source NEVER merges into an unflagged target —
 *     callers must leave the source file in place (inert tombstone).
 *  2. Exclusion/pointer fields never transfer between files in any merge:
 *     a flag describes the file it sits on, not the sibling.
 */

const EXCLUSION_FIELDS = [
  'rejectionReason', 'rejectionReasoning', 'rejectedBy', 'rejectedAt',
  'wrongProduction', 'wrongProductionNote', 'wrongProductionReason',
  'wrongShow', 'wrongShowReason',
  'isRoundupArticle', 'isRoundupArticleReason',
  'duplicateOf', 'duplicateReason', 'duplicateTextOf',
  'suspectedMisattribution', 'suspectedMisattributionReason',
];

function isExclusionFlagged(data) {
  if (!data) return false;
  return !!(
    data.rejectionReason ||
    data.wrongProduction === true ||
    data.wrongShow === true ||
    data.isRoundupArticle === true ||
    data.duplicateOf ||
    data.duplicateTextOf ||
    data.suspectedMisattribution === true
  );
}

/**
 * Merge source's fields into target (mutating target) where target lacks them.
 *
 * @returns {{ action: 'merged'|'skip-flagged-source', changed: boolean }}
 *   'skip-flagged-source' → target untouched; caller must NOT delete the source.
 */
function mergeUniqueReviewFields(target, source) {
  if (isExclusionFlagged(source) && !isExclusionFlagged(target)) {
    return { action: 'skip-flagged-source', changed: false };
  }
  let changed = false;
  for (const [key, val] of Object.entries(source || {})) {
    if (EXCLUSION_FIELDS.includes(key)) continue;
    if (val != null && !target[key]) {
      target[key] = val;
      changed = true;
    }
  }
  return { action: 'merged', changed };
}

module.exports = { mergeUniqueReviewFields, isExclusionFlagged, EXCLUSION_FIELDS };
