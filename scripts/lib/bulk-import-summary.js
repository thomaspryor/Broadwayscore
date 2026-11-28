/**
 * Bulk import summary — pure functions for run-bulk-historical-import.js.
 *
 * Per CLAUDE.md §15 (test-extraction pattern): the orchestrator's report
 * shape is extracted here so unit tests can require() it without spawning
 * child processes.
 *
 * A `showState` is one entry in the orchestrator's per-show ledger:
 *   {
 *     showId: 'evita-west-end-2025',
 *     reviewCount: 7,                  // includable reviews after gather + isIncludableForRebuild
 *     unknownCriticCount: 2,           // criticName === 'Unknown' (post-warmup)
 *     hasValidPoster: true,            // not the OG-fallback
 *     wrongProductionAll: false,       // 100% wrongProduction (i.e., dead show)
 *     gatherError: null                // string if the gather subprocess failed
 *   }
 *
 * `summarizeBulkImport` partitions the ledger into actionable buckets:
 *   - succeeded: reviewCount >= 3 AND hasValidPoster AND !wrongProductionAll
 *   - thinReviews: reviewCount < 3
 *   - missingPoster: reviewCount >= 3 AND !hasValidPoster
 *   - allWrongProduction: wrongProductionAll
 *   - failedGather: gatherError !== null
 *   - unknownCriticHotspots: shows with unknownCriticCount >= 2 (registry warmup gap)
 *
 * Plus an inverse-drop check against --expect-add: if expectAdd > 0 and
 * total reviews added < expectAdd * EXPECT_ADD_TOLERANCE, that's an alert.
 */

'use strict';

const EXPECT_ADD_TOLERANCE = 0.7; // 70% of expected = passing
const MIN_REVIEWS_FOR_DISPLAY = 3; // composite shown only at >= 5 in scoring lib;
                                    // bulk-import success bar is lower (3) to allow
                                    // historical shows where no composite is shown
                                    // but the show page is still useful.

/**
 * Partition show states into success / failure buckets.
 *
 * @param {Array<object>} showStates — per-show ledger entries
 * @param {object} [opts]
 * @param {number} [opts.expectAdd] — total reviews expected to be added across all shows
 * @returns {object} report with `summary`, `buckets`, `inverseDropAlert`
 */
function summarizeBulkImport(showStates, opts = {}) {
  if (!Array.isArray(showStates)) {
    throw new TypeError('showStates must be an array');
  }
  const expectAdd = Number.isFinite(opts.expectAdd) ? opts.expectAdd : 0;

  const buckets = {
    succeeded: [],
    thinReviews: [],
    missingPoster: [],
    allWrongProduction: [],
    failedGather: [],
    unknownCriticHotspots: [],
  };

  let totalReviewsAdded = 0;
  let totalUnknownCritics = 0;

  for (const s of showStates) {
    if (!s || typeof s.showId !== 'string') continue;
    const reviewCount = Number.isFinite(s.reviewCount) ? s.reviewCount : 0;
    totalReviewsAdded += reviewCount;
    totalUnknownCritics += Number.isFinite(s.unknownCriticCount) ? s.unknownCriticCount : 0;

    // Failure modes (mutually exclusive — first match wins).
    if (s.gatherError) {
      buckets.failedGather.push(s);
      continue;
    }
    if (s.wrongProductionAll === true) {
      buckets.allWrongProduction.push(s);
      continue;
    }
    if (reviewCount < MIN_REVIEWS_FOR_DISPLAY) {
      buckets.thinReviews.push(s);
      continue;
    }
    if (s.hasValidPoster === false) {
      buckets.missingPoster.push(s);
      continue;
    }
    // Otherwise: succeeded.
    buckets.succeeded.push(s);
  }

  // Unknown-critic hotspots — orthogonal to the success/failure axis. A show
  // can be in `succeeded` AND in `unknownCriticHotspots`: it has enough
  // reviews to display but the registry warmup didn't resolve everyone.
  for (const s of showStates) {
    if (s && Number.isFinite(s.unknownCriticCount) && s.unknownCriticCount >= 2) {
      buckets.unknownCriticHotspots.push(s);
    }
  }

  let inverseDropAlert = null;
  if (expectAdd > 0) {
    const ratio = totalReviewsAdded / expectAdd;
    if (ratio < EXPECT_ADD_TOLERANCE) {
      inverseDropAlert = {
        expected: expectAdd,
        actual: totalReviewsAdded,
        ratio: Number(ratio.toFixed(3)),
        threshold: EXPECT_ADD_TOLERANCE,
        message: `Bulk import added ${totalReviewsAdded} reviews; expected ${expectAdd} (${(ratio * 100).toFixed(1)}%, threshold ${(EXPECT_ADD_TOLERANCE * 100).toFixed(0)}%)`,
      };
    }
  }

  return {
    summary: {
      totalShows: showStates.length,
      succeeded: buckets.succeeded.length,
      thinReviews: buckets.thinReviews.length,
      missingPoster: buckets.missingPoster.length,
      allWrongProduction: buckets.allWrongProduction.length,
      failedGather: buckets.failedGather.length,
      unknownCriticHotspots: buckets.unknownCriticHotspots.length,
      totalReviewsAdded,
      totalUnknownCritics,
    },
    buckets,
    inverseDropAlert,
  };
}

/**
 * Render a one-page text report for stdout / GitHub Actions step summary.
 *
 * @param {object} report — output of summarizeBulkImport
 * @returns {string}
 */
function renderReport(report) {
  const { summary, buckets, inverseDropAlert } = report;
  const lines = [];
  lines.push('━'.repeat(70));
  lines.push('BULK HISTORICAL IMPORT — SUMMARY');
  lines.push('━'.repeat(70));
  lines.push(`Shows processed:           ${summary.totalShows}`);
  lines.push(`Succeeded (≥${MIN_REVIEWS_FOR_DISPLAY} reviews + poster):   ${summary.succeeded}`);
  lines.push(`Thin reviews (<${MIN_REVIEWS_FOR_DISPLAY}):           ${summary.thinReviews}`);
  lines.push(`Missing poster (OG fallback): ${summary.missingPoster}`);
  lines.push(`All wrong-production:      ${summary.allWrongProduction}`);
  lines.push(`Gather failures:           ${summary.failedGather}`);
  lines.push(`Reviews added (total):     ${summary.totalReviewsAdded}`);
  lines.push(`Unknown critics (total):   ${summary.totalUnknownCritics} across ${summary.unknownCriticHotspots} hotspot shows`);

  if (inverseDropAlert) {
    lines.push('');
    lines.push('⚠️  INVERSE-DROP ALERT');
    lines.push(`   ${inverseDropAlert.message}`);
  }

  // Action lists
  for (const [bucketName, label] of [
    ['failedGather', 'Failed gather (RETRY)'],
    ['allWrongProduction', 'All wrong-production (DEAD SHOWS — verify show metadata)'],
    ['thinReviews', 'Thin reviews (<3) — manual review needed'],
    ['missingPoster', 'Missing poster — re-run fetch-show-images-auto'],
    ['unknownCriticHotspots', 'Unknown-critic hotspots — manual registry mapping'],
  ]) {
    const items = buckets[bucketName] || [];
    if (items.length === 0) continue;
    lines.push('');
    lines.push(`${label}:`);
    for (const s of items) {
      const detail = bucketName === 'failedGather' ? ` — ${s.gatherError}`
        : bucketName === 'thinReviews' ? ` (${s.reviewCount} reviews)`
        : bucketName === 'unknownCriticHotspots' ? ` (${s.unknownCriticCount} unknown)`
        : '';
      lines.push(`  - ${s.showId}${detail}`);
    }
  }

  lines.push('━'.repeat(70));
  return lines.join('\n');
}

module.exports = {
  summarizeBulkImport,
  renderReport,
  EXPECT_ADD_TOLERANCE,
  MIN_REVIEWS_FOR_DISPLAY,
};
