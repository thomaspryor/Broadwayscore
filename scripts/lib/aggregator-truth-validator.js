'use strict';

/**
 * Pure decision logic for scripts/validate-aggregator-truth.js (BRO-2507).
 *
 * Extracted (CLAUDE.md §15, BRO-31 pattern: mobile-shows-validator.js) so the
 * ratio buckets can be unit-tested without data/aggregator-truth.json. No fs,
 * console or process.exit here; the script does the I/O and the printing.
 */

const THRESHOLDS = {
  WARN_DUPLICATE_RATIO: 1.5,   // localCount > maxAggregator * 1.5 = likely duplicates
  WARN_MISSING_RATIO: 0.7,     // localCount < maxAggregator * 0.7 = likely missing reviews
  FAIL_DUPLICATE_RATIO: 2.0,   // localCount > maxAggregator * 2.0 = definite problem
  MIN_AGGREGATOR_COUNT: 5,     // Only validate shows with at least this many aggregator reviews
};

// High-coverage shows that legitimately have 2x+ aggregator reviews (Tony
// winners, blockbusters). We collect from more sources than aggregators, so
// >2x is downgraded to a warning for these.
const HIGH_COVERAGE_EXCEPTIONS = new Set([
  'stereophonic-2024',           // Tony Best Play 2024, extraordinary coverage
  'illinoise-2024',              // Tony Best Choreography 2024
  'an-enemy-of-the-people-2024', // Star-driven, Ivo van Hove, extensive coverage
  'suffs-2024',                  // Tony Best Score 2024
  'hamilton-2015',               // Cultural phenomenon
  'hadestown-2019',              // Tony Best Musical 2019
]);

/**
 * Bucket every show in aggregator-truth.json's `shows` map.
 * @param shows { [showId]: { maxAggregator, localCount, ratio } }
 * @returns { definiteDuplicates, likelyDuplicates, likelyMissing, noAggregatorData, healthy }
 *   definiteDuplicates are the gate's errors (exit 1); the rest are warnings/info.
 *   Arrays are in input order (the script sorts them for display).
 */
function classifyAggregatorTruth(shows, exceptions = HIGH_COVERAGE_EXCEPTIONS) {
  const likelyDuplicates = [];
  const definiteDuplicates = [];
  const likelyMissing = [];
  const noAggregatorData = [];
  const healthy = [];

  for (const showId of Object.keys(shows || {})) {
    const entry = shows[showId] || {};
    const { maxAggregator, localCount } = entry;
    // Derive the ratio when the stored one is missing or not a number, so a
    // generator regression cannot drop a 3x duplicate into "healthy"
    // (BRO-5261 retro-review).
    const ratio = Number.isFinite(entry.ratio) ? entry.ratio
      : (Number.isFinite(localCount) && maxAggregator > 0 ? localCount / maxAggregator : null);

    // New shows / not yet indexed by aggregators
    if (ratio === null || !(maxAggregator > 0)) {
      noAggregatorData.push({ showId, localCount, maxAggregator });
      continue;
    }

    // Too few aggregator reviews to judge, but still catch extreme duplicates
    if (maxAggregator < THRESHOLDS.MIN_AGGREGATOR_COUNT) {
      if (ratio > THRESHOLDS.FAIL_DUPLICATE_RATIO) {
        definiteDuplicates.push({ showId, localCount, maxAggregator, ratio });
      }
      continue;
    }

    if (ratio > THRESHOLDS.FAIL_DUPLICATE_RATIO) {
      if (exceptions.has(showId)) {
        likelyDuplicates.push({ showId, localCount, maxAggregator, ratio, isException: true });
      } else {
        definiteDuplicates.push({ showId, localCount, maxAggregator, ratio });
      }
    } else if (ratio > THRESHOLDS.WARN_DUPLICATE_RATIO) {
      likelyDuplicates.push({ showId, localCount, maxAggregator, ratio });
    } else if (ratio < THRESHOLDS.WARN_MISSING_RATIO) {
      likelyMissing.push({ showId, localCount, maxAggregator, ratio });
    } else {
      healthy.push({ showId, localCount, maxAggregator, ratio });
    }
  }

  return { definiteDuplicates, likelyDuplicates, likelyMissing, noAggregatorData, healthy };
}

module.exports = {
  THRESHOLDS,
  HIGH_COVERAGE_EXCEPTIONS,
  classifyAggregatorTruth,
};
