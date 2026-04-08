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
  'designation',
  'isCriticsPick',
  'duplicateOf',
  'duplicateReason',
  'publishDateVerified',
  'publishDateSource',
  'allowEarlyDate',
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
      for (const field of PROTECTED_FIELDS) {
        if (existing[field] !== undefined && existing[field] !== null && (newData[field] === undefined || newData[field] === null)) {
          newData[field] = existing[field];
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

  const losses = [];
  for (const field of PROTECTED_FIELDS) {
    if (existing[field] !== undefined && existing[field] !== null && (newData[field] === undefined || newData[field] === null)) {
      losses.push(field);
    }
  }
  return losses;
}

module.exports = { safeWriteReview, checkForDataLoss, PROTECTED_FIELDS };
