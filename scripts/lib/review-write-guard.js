/**
 * Review Write Guard
 *
 * Prevents accidental destruction of scored/collected review data.
 * Any script that writes review JSON files should use safeWriteReview()
 * instead of raw fs.writeFileSync().
 *
 * Protected fields: assignedScore, llmScore, fullText, contentTier,
 * contentVerification, ensembleData, llmMetadata.
 *
 * Rules:
 * - If an existing file has a scored field and the new data doesn't,
 *   the scored field is preserved from the existing file.
 * - Set force=true to bypass (for intentional score clearing like rescoring).
 *
 * Used by:
 * - scripts/sweep-we-aggregators.js
 * - scripts/gather-reviews.js (review file creation)
 * - Any future script that writes to data/review-texts/
 */

const fs = require('fs');
const path = require('path');

// Fields that represent collected/scored data and must not be silently erased.
// KEEP IN SYNC with .github/actions/push-review-texts/action.yml PROTECTED array.
const PROTECTED_FIELDS = [
  'assignedScore',
  'humanReviewScore',
  'adjudicatedScore',
  'adjudicationNote',
  'manualContentTier',
  'originalScore',
  'originalScoreSource',
  'originalScoreNormalized',
  'llmScore',
  'llmMetadata',
  'fullText',
  'contentTier',
  'contentTierReason',
  'contentVerification',
  'ensembleData',
  'tierReason',
  'showTitle',
  'textFetchedAt',
  'textWordCount',
  'textStatus',
  'sourceMethod',
  'isFullReview',
  'wrongFullText',
  'wrongShow',
  'wrongShowReason',
  'wrongProduction',
  'wrongProductionNote',
  'incompleteReason',
  'incompleteDetail',
  'originalScoreCleared',
  'originalScoreClearedReason',
  'previousOriginalScore',
  'humanReviewNote',
  'humanReviewedWrongProduction',
  'wrongProductionManualClear',
  'wrongProductionOverride',
  'designation',
  'isCriticsPick',
  'duplicateOf',
  'duplicateReason',
  'publishDateVerified',
  'publishDateSource',
  'allowEarlyDate',
  'urlVerified',
  'urlManualOverride',
  'urlManualOverrideNote',
  // SERP retry state — set by collect-review-texts.js + gather-reviews.js lifecycle guard.
  // Losing these on rebase causes the cooldown to reset, which means a single
  // rebase can re-trigger 13K stuck wrong_content files. See sprint-plan-serp-cost-reduction.md S1-T1.
  // NOTE: serpRetryCount/serpDiscoveryAbandoned are intentionally excluded — clearFailureFlags()
  // clears them on success. serpRetryAfter is still protected (controls backoff timing).
  'serpRetryAfter',
  'wrongShowRetryAt', // existing bug fix — was silently droppable on rebase
  // NOTE: incompleteReason + incompleteDetail are intentionally NOT in this list.
  // They are derived fields that rebuild re-classifies every run. Having them here
  // caused stale 'wrong_content' flags to be preserved even after collect-review-texts.js
  // fetched correct content — blocking valid reviews from reviews.json.
  // clearFailureFlags() clears them explicitly on success paths. (Pattern Card #1,
  // Notion 346637c5-416f-8154-9500-f09fd49e5a2a, 2026-04-17)
];

/**
 * Safely write a review JSON file, preserving any existing scored/collected data.
 *
 * @param {string} filePath - Absolute path to the review JSON file
 * @param {object} newData - The data to write
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Skip protection (for intentional overwrites like rescoring)
 * @param {boolean} [options.merge=true] - If true, merge with existing; if false, replace (still protected)
 * @returns {{ wrote: boolean, preserved: string[] }} Which protected fields were preserved
 */
function safeWriteReview(filePath, newData, options = {}) {
  const { force = false, merge = true } = options;
  const preserved = [];

  if (!force && fs.existsSync(filePath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      existing = null;
    }

    if (existing) {
      const effectiveFields = getEffectiveProtectedFields(existing);
      for (const field of effectiveFields) {
        const existingVal = existing[field];
        const newVal = newData[field];
        // Preserve existing non-empty when incoming is any form of empty.
        // Previously only undefined/null were treated as empty — the poller
        // writes stubs with fullText='' (empty string) which passed the
        // check and CLOBBERED scored reviews. See 2026-04-17 Proof opening
        // P0 incident (card 345637c5-416f-81df).
        const existingIsReal = existingVal !== undefined && existingVal !== null
          && !(typeof existingVal === 'string' && existingVal.length === 0)
          && !(Array.isArray(existingVal) && existingVal.length === 0);
        const incomingIsEmpty = newVal === undefined || newVal === null
          || (typeof newVal === 'string' && newVal.length === 0)
          || (Array.isArray(newVal) && newVal.length === 0);
        if (existingIsReal && incomingIsEmpty) {
          newData[field] = existingVal;
          preserved.push(field);
        }
      }

      // If merge mode, also keep any existing fields not in newData
      if (merge) {
        for (const [key, val] of Object.entries(existing)) {
          if (newData[key] === undefined) {
            newData[key] = val;
          }
        }
      }
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2) + '\n');
  return { wrote: true, preserved };
}

/**
 * Check if writing newData would destroy scored data in an existing file.
 * Returns list of fields that would be lost. Empty array = safe to write.
 *
 * @param {string} filePath - Path to existing review file
 * @param {object} newData - Proposed new data
 * @returns {string[]} Fields that would be lost
 */
function checkForDataLoss(filePath, newData) {
  if (!fs.existsSync(filePath)) return [];
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }

  const effectiveFields = getEffectiveProtectedFields(existing);
  const losses = [];
  for (const field of effectiveFields) {
    if (existing[field] !== undefined && existing[field] !== null && (newData[field] === undefined || newData[field] === null)) {
      losses.push(field);
    }
  }
  return losses;
}

/**
 * Returns the effective set of protected fields for a given existing file's data.
 * Unions the global PROTECTED_FIELDS with any per-file protectedFields array.
 * 'protectedFields' itself is always included so it can't be cleared unless force=true.
 *
 * @param {object|null} existingData - Parsed JSON from the existing file (or null)
 * @returns {string[]}
 */
function getEffectiveProtectedFields(existingData) {
  const perFile = (existingData && Array.isArray(existingData.protectedFields))
    ? existingData.protectedFields
    : [];
  const all = new Set([...PROTECTED_FIELDS, ...perFile, 'protectedFields']);
  return Array.from(all);
}

module.exports = { safeWriteReview, checkForDataLoss, getEffectiveProtectedFields, PROTECTED_FIELDS };
