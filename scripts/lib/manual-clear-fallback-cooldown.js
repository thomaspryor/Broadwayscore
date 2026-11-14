/**
 * Backoff for the manually-cleared Haiku-fallback rescue in
 * scripts/llm-scoring/index.ts (§15 pure decision fn).
 *
 * A file whose wrongProduction/wrongShow was manually cleared by a human but
 * whose Haiku rescue fails to produce a score used to leave ZERO state on
 * disk — every subsequent scoring run re-ran the full ensemble + fallback
 * from scratch on the same file forever, burning API credits with no
 * progress (P1 352637c5-416f-81ab). recordManualClearFallbackFailure() in
 * index.ts now persists manualClearFallbackFailedAt/Attempts; this predicate
 * reads them back so the file-selection filter can skip re-processing until
 * the backoff window elapses. Mirrors the serpRetryAfter cooldown pattern in
 * review-guards.js.
 */

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h base backoff
const MAX_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000; // capped at 7 days

function isInFallbackCooldown(reviewData, now = Date.now()) {
  if (!reviewData || !reviewData.manualClearFallbackFailedAt) return false;
  // Abandoned files never auto-retry — the backoff below would otherwise
  // recompute a finite window from mutable historical fields and retry
  // forever (Codex adversarial review, P1 352637c5-416f-81ab ship-check).
  if (reviewData.manualClearFallbackAbandoned === true) return true;
  const failedAt = new Date(reviewData.manualClearFallbackFailedAt).getTime();
  if (Number.isNaN(failedAt)) return false;
  const attempts = Number(reviewData.manualClearFallbackAttempts) || 1;
  const backoff = Math.min(COOLDOWN_MS * attempts, MAX_BACKOFF_MS);
  return now < failedAt + backoff;
}

module.exports = { isInFallbackCooldown, COOLDOWN_MS, MAX_BACKOFF_MS };
