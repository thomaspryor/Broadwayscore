'use strict';

/**
 * BRO-75: analyzes exclusion-logger output for the `skippedWrongProduction`
 * reason to distinguish genuine over-blocking from log noise.
 *
 * Root cause found investigating beetlejuice-2022's reported 261/day volume:
 * rebuild-all-reviews.js re-logs `skippedWrongProduction` for every review
 * file that still carries `wrongProduction: true` on EVERY rebuild pass (the
 * flag is sticky — nothing clears it once set, see rebuild-all-reviews.js
 * ~line 2805). beetlejuice-2022 has 94 files flagged wrongProduction, all
 * touring/prior-run reviews correctly excluded (2019 NYT/Post/Vulture
 * reviews of the original run, scraped into the 2022 return-engagement show
 * ID; BWW national-tour city reviews). 94 files x ~3 rebuild runs/day ≈ 261
 * log lines — the same known-bad files re-logged, not 261 new mistakes.
 * moulin-rouge-the-musical-west-end-2021 (82/114 flagged) and
 * pretty-woman-the-musical-2018 (75/129 flagged) show the identical pattern.
 */

const trend = require('./exclusion-trend');

const REASON = 'skippedWrongProduction';
// Preserve the narrow API's treatment of '-' as a filename. The generalized
// digest excludes unidentified events from its ledger evidence by default.
const COMPAT_OPTIONS = { includeUnidentifiedFiles: true };
const { parseExclusionLog } = trend;

function wrongProductionRecords(records) {
  return records.filter((rec) => rec && rec.reason === REASON);
}

/** Adapt the generalized result to the existing per-show public shape. */
function showResult({ showId, totalLines, distinctFiles, repeatMultiplier, newFileCount, category }) {
  return {
    showId,
    totalLines,
    distinctFiles,
    repeatMultiplier,
    ...(newFileCount !== undefined ? { newFileCount } : {}),
    category,
  };
}

/** Group only wrong-production events, keeping the legacy Set-based shape. */
function summarizeByShow(records) {
  const groups = trend.summarizeByReasonAndShow(wrongProductionRecords(records));
  return new Map([...groups.values()].map(({ showId, fileCounts }) => [showId, {
    showId,
    totalLines: [...fileCounts.values()].reduce((sum, n) => sum + n, 0),
    files: new Set(fileCounts.keys()),
  }]));
}

/** Delegate aggregate categorization, including custom thresholds/knownFiles. */
function categorizeShow(entry, opts = {}) {
  return showResult(trend.categorizeGroup(entry, { ...opts, ...COMPAT_OPTIONS }));
}

/** Adapt the per-show ledger to the generalized reason-keyed ledger. */
function analyzeExclusionLog(jsonlText, opts = {}) {
  const { knownFilesByShow, ...rest } = opts;
  const filteredText = wrongProductionRecords(parseExclusionLog(jsonlText))
    .map((rec) => JSON.stringify(rec)).join('\n');
  return trend.analyzeExclusionLog(filteredText, {
    ...rest,
    ...COMPAT_OPTIONS,
    knownFilesByReasonAndShow: knownFilesByShow ? { [REASON]: knownFilesByShow } : undefined,
  }).map(showResult);
}

/** Union the same files using the generalized ledger builder. */
function buildNextLedger(records, previousLedger = {}) {
  return trend.buildNextLedger(wrongProductionRecords(records), {
    [REASON]: previousLedger,
  }, COMPAT_OPTIONS)[REASON];
}

module.exports = {
  parseExclusionLog,
  summarizeByShow,
  categorizeShow,
  analyzeExclusionLog,
  buildNextLedger,
};
