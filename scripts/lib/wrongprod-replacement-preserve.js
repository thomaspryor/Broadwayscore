/**
 * Pure function: compute which fields to carry forward from an existing review
 * file when gather-reviews.js is REPLACING it on a fresh URL (wrongShow /
 * wrongProduction file whose correct URL was just re-discovered).
 *
 * Extracted from scripts/gather-reviews.js so tests can require() the real
 * function per CLAUDE.md §15. Historical context: the original hardcoded
 * 13-field preserve list drifted from the canonical PROTECTED_FIELDS
 * (review-write-guard.js), silently dropping adjudicatedScore, manualContentTier,
 * llmMetadata, contentVerification, ensembleData, showTitle, textFetchedAt,
 * textWordCount, textStatus, sourceMethod, plus all human-decision fields
 * (humanReviewedWrongProduction, urlManualOverride, etc.) on every URL
 * re-discovery. /ship-check on 2026-04-22 flagged it.
 *
 * Caller contract: the result gets spread INTO `replacement = {...newData, ...preserved}`,
 * then downstream code explicitly deletes the OLD production's blocking flags
 * (wrongProduction, wrongShow, contentTier, incompleteReason, contentVerification.*).
 * Those deletes are the safety net — this function just returns what to carry.
 */

const { PROTECTED_FIELDS } = require('./review-write-guard');

// Aggregator signals — always preserve regardless of scoring state. These live
// in the source review JSON and are independent of production validity.
const AGGREGATOR_FIELDS = [
  'bwwScore', 'bwwExcerpt',
  'showScoreRating', 'showScoreExcerpt',
  'dtliThumb', 'dtliExcerpt',
];

// Human-decision fields — a policy statement from a human reviewer. Survives
// regardless of alreadyScored state. Previously gated behind the scoring check,
// which silently dropped urlManualOverride / manualContentTier / wrongProduction
// ManualClear etc. on any URL replacement.
const HUMAN_DECISION_FIELDS = [
  'humanReviewedWrongProduction', 'humanReviewedWrongArticle',
  'humanReviewNote', 'humanReviewScore',
  'wrongProductionManualClear', 'wrongArticleManualClear', 'wrongShowManualClear',
  'wrongProductionOverride',
  'urlManualOverride', 'urlManualOverrideNote', 'urlVerified',
  'manualContentTier',
  'pullQuote',
  'designation', 'isCriticsPick',
];

// Fields explicitly cleared on URL replacement. These are the OLD production's
// flags and MUST NOT survive. The caller's delete block is the enforcement;
// this set exists so we can subtract from PROTECTED_FIELDS when building the
// scored-content preserve list (and so a future PROTECTED_FIELDS addition that
// should be cleared lands in one obvious place).
const REPLACE_CLEAR_FIELDS = new Set([
  'wrongProduction', 'wrongProductionReason', 'wrongProductionNote',
  'wrongShow', 'wrongShowReason', 'wrongShowNote', 'wrongShowAutoCleared',
  'contentTier', 'contentTierReason',
  'incompleteReason', 'incompleteDetail',
  'rejectionReason', 'rejectedBy', 'rejectionReasoning',
  'fetchAttempts', 'lastFetchDate',
  'contentVerification',
]);

// Extra fields the legacy hardcoded list preserved that aren't in PROTECTED_FIELDS.
// These are derived/metadata — downstream rebuild logic expects them to carry.
const REPLACE_PRESERVE_EXTRAS = [
  'scoreStatus', 'originalRating', 'publishDate', 'criticName',
];

// Derived: every PROTECTED_FIELD that isn't intentionally cleared, plus the extras.
// Adding a new field to PROTECTED_FIELDS automatically covers this path. No drift.
const SCORED_PRESERVE_FIELDS = Array.from(new Set([
  ...PROTECTED_FIELDS.filter(f => !REPLACE_CLEAR_FIELDS.has(f)),
  ...REPLACE_PRESERVE_EXTRAS,
]));

/**
 * @param {object} existingReview  Parsed JSON of the existing review file
 * @param {{alreadyScored: boolean}} opts
 * @returns {object}  Fields to spread into the replacement write
 */
function computeReplacementPreserve(existingReview, { alreadyScored } = {}) {
  const preserved = {};
  if (!existingReview) return preserved;

  for (const key of AGGREGATOR_FIELDS) {
    if (existingReview[key] !== undefined) preserved[key] = existingReview[key];
  }

  if (alreadyScored) {
    for (const key of SCORED_PRESERVE_FIELDS) {
      if (existingReview[key] !== undefined) preserved[key] = existingReview[key];
    }
  }

  // ALWAYS preserve human-decision fields, regardless of alreadyScored.
  for (const key of HUMAN_DECISION_FIELDS) {
    if (existingReview[key] !== undefined) preserved[key] = existingReview[key];
  }

  return preserved;
}

module.exports = {
  computeReplacementPreserve,
  AGGREGATOR_FIELDS,
  HUMAN_DECISION_FIELDS,
  REPLACE_CLEAR_FIELDS,
  REPLACE_PRESERVE_EXTRAS,
  SCORED_PRESERVE_FIELDS,
};
