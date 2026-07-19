/**
 * Single source of truth for "would a review-text file be included in reviews.json?"
 *
 * Used by:
 *   - scripts/validate-data.js   (validateUnscoredReviewTexts — silent-gap audit)
 *   - scripts/check-review-count-drift.js   (drift health check)
 *
 * This predicate mirrors the skip logic rebuild-all-reviews.js applies at ingest,
 * PLUS a score-presence check (rebuild drops files with no valid score via
 * stats.skippedNoScore). If both predicates pass we expect the file to contribute
 * one entry to reviews.json for its showId.
 *
 * Known limitations — rebuild has context-dependent guards that cannot be
 * expressed as pure predicates over a single file:
 *   - showNotMentioned auto-clear via text scan + LLM CV
 *   - cross-market + cross-show guards (need show category, outlet registry, slug index)
 *   - pre-opening date guard (needs earliest show date)
 *   - runtime syndication dedup (needs sibling JSON files)
 *   - temporal overrides on wrongProduction (need shows.json context)
 *
 * Consequence: `wouldBeIncludedInRebuild()` is an UPPER bound on inclusion.
 * In practice it over-estimates by a small number per show, which is fine for
 * drift monitoring (a single-show delta > 3 is the alert threshold — noise from
 * context guards is far below that).
 *
 * When rebuild adds a new pure-flag skip, mirror it here. When rebuild adds a
 * new context-dependent skip, document it above instead of mirroring.
 */

/**
 * Pure-flag exclusion check. Returns true iff the file passes every flag that
 * rebuild checks against a single review-text object in isolation.
 *
 * NOTE: dedup fields are inconsistent across the codebase:
 *   - `duplicateOf`     — older, used by scripts/lib/is-scoreable.js
 *   - `duplicateTextOf` — newer, used by rebuild-all-reviews.js
 * Both are checked to match validate-data.js behavior (2026-04-11 fix that
 * stopped falsely flagging 39 duplicateOf files as silent gaps).
 */
const { isLikelyStaleRoundupFlag, isRoundupPageAsReview, isLikelyStaleWrongShow, wrongShowCleared, isLikelyStaleSuspectedMisattribution, getCriticRegistry } = require('./review-guards');
const { parseOriginalScore } = require('./score-parsers');

function passesFlagFilters(data, show) {
  if (!data) return false;

  // S3-T6: CV-promotion-deferred reviews are explicitly includable.
  // Mirrors the documentation block in review-guards.js:isIncludableForRebuild.
  // The defer (S3-T5, rebuild-all-reviews.js sets
  // `flaggedForReview=true` + `flagReason='cv-promotion-deferred'`) prevents
  // the LLM-CV pass from silently promoting biographical-lead reviews to
  // wrongShow at outlets with `cvStyle: 'biographical-lead'`. These reviews
  // are scoreable + must appear in reviews.json. We do not gate on
  // `flaggedForReview` anywhere here today, but documenting the contract
  // future-proofs against a generic flag-based reject being added.
  // Cross-ref: memory/feedback_includability_predicates_must_be_canonical.md

  if (data.rejectionReason) return false;
  if (Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) return false;
  if (data.isRoundupArticle === true && !isLikelyStaleRoundupFlag(data)) return false;
  if (isRoundupPageAsReview(data)) return false; // parity with isIncludableForRebuild (ship-check 2026-07-10)
  if (data.wrongAttribution === true) return false;
  if (data.suspectedMisattribution === true && !isLikelyStaleSuspectedMisattribution(data, getCriticRegistry())) return false;
  if (data.wrongProduction) return false;
  // wrongShow: defer to manual-clear flags + isLikelyStaleWrongShow override.
  // Mirrors the symmetric gate added in isIncludableForRebuild + isScoreable
  // (Notion 34e637c5-416f-8121). Without this, the validate-data + drift-check
  // probes over-count silent gaps — they'd flag manually-cleared wrongShow
  // files as "should be in reviews.json but isn't" when rebuild does include
  // them.
  if (data.wrongShow && !wrongShowCleared(data) && !isLikelyStaleWrongShow(data, show)) return false;
  if (data.duplicateTextOf) return false;
  if (data.duplicateOf) return false;
  if (data.humanReviewedWrongProduction) return false;
  if (data.contentTier === 'invalid') return false;
  // Stub: the real rebuild (review-guards.js isIncludableForRebuild "Must
  // have either review text or an aggregator signal") INCLUDES textless
  // stubs that carry a score signal — e.g. The Stage paywall stubs scored
  // from first-party page stars (originalScore, stage-star-svg). Blanket
  // stub-rejection here made star-scored live entries (360-allstars,
  // heathers/smile thestage) read as "won't reach reviews.json" (2026-07-18).
  if (data.contentTier === 'stub' && !hasValidScore(data)) return false;
  if (data.scoreStatus === 'TO_BE_CALCULATED') return false;

  // Additional rebuild-exclusion flags that the pre-2026-04-22 inline logic
  // in validate-data.js was missing — mirrors scripts/lib/review-guards.js
  // :isIncludableForRebuild so the drift check + silent-gap audit don't
  // over-count files rebuild legitimately excludes.
  if (
    data.isNonReview === true ||
    data.isNotReview === true ||
    data.nonReviewFlag === true ||
    data.nonReviewContent === true
  ) return false;
  if (data.fabricatedEntry === true) return false;
  if (data.isSyndicatedDuplicate === true) return false;
  if (data.crossOutletDuplicate === true) return false;
  // High-confidence content-verification mismatch. Matches rebuild's gate at
  // review-guards.js:1248 exactly — high-confidence only; lower confidences
  // are merely advisory and rebuild still includes the file.
  if (
    data.contentVerification &&
    data.contentVerification.wrongArticle === true &&
    data.contentVerification.confidence === 'high'
  ) return false;
  // Canonical exclusion signal set by llm-scoring when the ensemble rejects
  // a review (wrong_production, wrong_show, not_a_review, garbage_text).
  // Cleared by a successful re-scrape (collect-review-texts.js). Exception:
  // if text was re-fetched AFTER rejection, treat as revalidated and let
  // downstream scoring decide.
  if (data.rejectedAt && typeof data.rejectedAt === 'string') {
    const reFetched =
      data.textFetchedAt &&
      typeof data.textFetchedAt === 'string' &&
      data.textFetchedAt > data.rejectedAt;
    if (!reFetched) return false;
  }

  // showNotMentioned + fullTextWrongAuthor only skip when there are no aggregator
  // excerpts to fall back on. Mirrors is-scoreable.js and validate-data.js logic.
  if (data.showNotMentioned && !hasAggregatorExcerpt(data)) return false;
  if (data.fullTextWrongAuthor === true && !hasAggregatorExcerpt(data)) return false;

  return true;
}

function hasAggregatorExcerpt(data) {
  return !!(
    data.bwwExcerpt || data.dtliExcerpt || data.showScoreExcerpt ||
    data.nycTheatreExcerpt || data.stagedoorExcerpt || data.lboRoundupExcerpt
  );
}

/**
 * Does this review-text file have any valid score path? Mirrors
 * rebuild-helpers.js:getBestScore priority list (human → adjudicated →
 * originalScore → llmScore → assignedScore → aggregatorStars).
 */
function hasValidScore(data) {
  if (!data) return false;
  const hasHuman = data.humanReviewScore >= 1 && data.humanReviewScore <= 100;
  const hasAdj = data.adjudicatedScore >= 1 && data.adjudicatedScore <= 100;
  // originalScore must be a rating rebuild can actually use: either a stored
  // normalized value, or a raw string the rebuild parser accepts (numeric,
  // star form, letter grade). A truthy-but-unparseable string ("N/A",
  // "see review") is NOT a score — counting it made junk-scored stubs
  // invisible to the silent-gap audit (ship-check 2026-07-18).
  const normOk = typeof data.originalScoreNormalized === 'number'
    && data.originalScoreNormalized >= 1 && data.originalScoreNormalized <= 100;
  const hasOrig = !data.originalScoreCleared && !!data.originalScore
    && (normOk || parseOriginalScore(String(data.originalScore)) != null);
  const hasLlm = data.llmScore && data.llmScore.score >= 1 && data.llmScore.score <= 100;
  const hasAssigned = data.assignedScore >= 1 && data.assignedScore <= 100;
  const hasAggStars = !!data.aggregatorStars;
  return !!(hasHuman || hasAdj || hasOrig || hasLlm || hasAssigned || hasAggStars);
}

/**
 * Main predicate. Returns true iff we expect rebuild to include this file in
 * reviews.json for its showId (modulo the context-dependent guards noted above).
 *
 * @param {object} data - Review-text JSON
 * @param {object} [show] - Show entry from shows.json. Optional but required
 *   for accurate stale-wrongShow detection (Notion 34e637c5-416f-8121); when
 *   missing, the predicate degrades to old behavior (all wrongShow files
 *   without manual-clear are excluded).
 */
function wouldBeIncludedInRebuild(data, show) {
  return passesFlagFilters(data, show) && hasValidScore(data);
}

module.exports = {
  wouldBeIncludedInRebuild,
  passesFlagFilters,
  hasValidScore,
  hasAggregatorExcerpt,
};
