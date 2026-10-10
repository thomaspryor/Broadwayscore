/**
 * llm-ensemble-score.yml "Check for changes" gate — pure decision fn (§15).
 *
 * The workflow used to gate downstream steps (stranded-scores supplement,
 * chain-continuation, the "0 reviews scored" notice) on
 * scoring-progress.json's `processed` count alone. An all-rejected batch
 * (every file hit wrong_production/wrong_show/not_a_review/garbage_text)
 * writes rejectedAt/rejectionReason/etc. to disk via saveReviewFile() but
 * increments `skipped`, not `processed` — so those downstream steps saw
 * "nothing happened" even though real review-text state changed. Reading
 * `filesModified` (every saveReviewFile() call this run, scored OR
 * rejected — scripts/llm-scoring/index.ts) instead of `processed` alone
 * fixes that. See P1 352637c5-416f-81ab.
 */

function hasScoredReviews(progress) {
  if (!progress || typeof progress !== 'object') return false;
  const filesModified = Number(progress.filesModified) || 0;
  const processed = Number(progress.processed) || 0;
  return filesModified > 0 || processed > 0;
}

module.exports = { hasScoredReviews };
