/**
 * t1-silent-gap.js
 *
 * Pure classifier for the "major-outlet review silently missing from the
 * score" failure class (2026-07-18: The Times/Oresteia sat as an empty
 * paywall stub for 3 days; NYT/Potluck as a bot-stub rejected by the
 * scoreability check — neither was recovered or escalated because the
 * aggregator-gap audit only sees files whose URL an aggregator article
 * lists, and no alert ever fires for a discovered-but-unscoreable file).
 *
 * A silent gap is a review-texts dir file for a tier-1/2 outlet on a
 * recently-opened show that will NOT contribute to the composite score and
 * is not legitimately excluded. The classifier is dir-driven: it needs only
 * the file's own JSON (which always carries the discovered URL), not an
 * aggregator citation.
 *
 * Kept pure (no fs / no fetch) per the test-extraction rule — the sweep
 * runner (scripts/audit-t1-silent-gaps.js) and the unit test share it.
 */

'use strict';

const { isEmptyBodyFile, isRecoverableFlaggedFile } = require('./flagged-recovery');

// Tiers considered "cannot silently miss". 1 = NYT/Times/Guardian class,
// 2 = TheaterMania/Standard/Telegraph class.
const MAJOR_TIER_MAX = 2;

// Re-alert the same file at most once per this many days.
const REALERT_DAYS = 7;

/**
 * Classify one dir file. Returns null when there is nothing to escalate,
 * else { type, recoverable }.
 *
 * type:
 *   'empty-body'           — no usable text/stars/score; re-ingest from the
 *                            file's own URL may heal it (recoverable=true
 *                            while merge-safe and under the shared retry cap)
 *   'rejected-unscoreable' — has text but the scoring ensemble rejected it
 *                            (bot-stub / truncation class); needs a better
 *                            fetch, so report + alert only
 *   'unscored'             — scoreable content but the scoring pipeline never
 *                            produced a score; fix = dispatch scoring
 *
 * "Scored but not yet in reviews.json" is deliberately NOT a gap type —
 * the rebuild cron closes that within hours (task #178 fixed the strand).
 *
 * @param {object} args
 * @param {object} args.file            parsed review-text JSON
 * @param {number} args.tier            outlet tier (getTier(outletId, {showCategory}))
 * @param {boolean} args.outletScored   this outlet already has a scored entry
 *                                      for the show (reviews.json or a scored
 *                                      sibling file) — gap only when false
 * @returns {null | {type: string, recoverable: boolean}}
 */
function classifySilentGap({ file, tier, outletScored }) {
  if (!file || typeof file !== 'object') return null;
  if (tier == null || tier > MAJOR_TIER_MAX) return null;
  if (outletScored) return null;

  // Legitimate exclusions — the review SHOULD be absent from the score.
  if (file.wrongProduction === true || file.wrongShow === true) return null;
  if (file.isNonReview === true || file.isRoundupArticle === true) return null;
  if (file.duplicateOf || file.duplicateTextOf) return null;
  if (file.rejectionReason === 'not_a_review') return null;
  // Collector LLM classed it as a feature/preview — same not-a-review family.
  if (typeof file.rejectionReasoning === 'string' && /not a review/i.test(file.rejectionReasoning)
      && !file.rejectedBy) return null;
  if (file.humanReviewScore != null) return null; // human-set — already handled
  // Adjudicated star-stubs (paywalled outlets scored via aggregator stars,
  // e.g. The Stage) are live scores even with an empty body.
  if (file.adjudicatedScore != null) return null;

  if (isEmptyBodyFile(file)) {
    return { type: 'empty-body', recoverable: isRecoverableFlaggedFile(file) };
  }

  const scored = file.llmScore != null || file.assignedScore != null
    || file.aggregatorStars != null || file.originalScore != null;

  // Scoreability rejection with no surviving score (NYT bot-stub class).
  // A file can carry an assignedScore AND a rejection stamp (the ensemble
  // rejected the text after a provisional score) — the rejection wins at
  // rebuild, so it is still a gap.
  if (file.rejectedBy || file.rejectionReason) {
    return { type: 'rejected-unscoreable', recoverable: false };
  }

  if (!scored) return { type: 'unscored', recoverable: false };

  return null; // scored and unrejected — rebuild/deploy lag at worst
}

/**
 * Alert dedupe: should this gap email now?
 * @param {string|null} lastAlertedAt ISO timestamp of the previous alert for
 *                                    this show/file key (null = never)
 * @param {Date} now
 */
function shouldAlertGap(lastAlertedAt, now) {
  if (!lastAlertedAt) return true;
  const last = Date.parse(lastAlertedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= REALERT_DAYS * 24 * 60 * 60 * 1000;
}

module.exports = { classifySilentGap, shouldAlertGap, MAJOR_TIER_MAX, REALERT_DAYS };
