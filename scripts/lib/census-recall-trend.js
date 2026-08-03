'use strict';

/**
 * census-recall-trend.js — pure regression detector over
 * data/audit/serp-census-recall-history.json (task #898/#901).
 *
 * #872 shipped the naive-query recall harness as a one-shot: it overwrote
 * data/audit/serp-census-recall.json on every run with no prior data point to
 * diff against, so a broken arm (the #647 class) would look identical to a
 * healthy one in the committed snapshot. audit-serp-census-recall.js now
 * appends each run's totals to the history file this reads.
 */

const NAIVE_DROP_THRESHOLD_PP = 10;
const TREND_WINDOW = 4;

function mean(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

/**
 * censusRecallTrendResults(history) — warns when either:
 *  - naiveRecall drops >10pp vs the trailing (up to 4) prior runs' mean, or
 *  - combinedRecall (scoped+onDisk coverage) falls vs the immediately prior run.
 * Returns a health-check.js-shaped results array (empty when nothing to flag).
 */
function censusRecallTrendResults(history) {
  if (!Array.isArray(history) || history.length < 2) return [];

  const current = history[history.length - 1];
  const prior = history.slice(0, -1).slice(-TREND_WINDOW);
  if (!prior.length || !current || !current.totals) return [];

  const currentNaive = current.totals.naiveRecall;
  const meanNaive = mean(prior.map((r) => r.totals && r.totals.naiveRecall));
  const naiveDropPP = (typeof currentNaive === 'number' && meanNaive != null)
    ? Math.round((meanNaive - currentNaive) * 1000) / 10
    : 0;

  const previous = prior[prior.length - 1];
  const currentCombined = current.totals.combinedRecall;
  const previousCombined = previous.totals && previous.totals.combinedRecall;
  const combinedFell = typeof currentCombined === 'number' && typeof previousCombined === 'number'
    && currentCombined < previousCombined;

  if (naiveDropPP <= NAIVE_DROP_THRESHOLD_PP && !combinedFell) return [];

  const parts = [];
  if (naiveDropPP > NAIVE_DROP_THRESHOLD_PP && typeof currentNaive === 'number' && meanNaive != null) {
    parts.push(`naive recall dropped ${naiveDropPP}pp vs the trailing ${prior.length}-run mean (${(meanNaive * 100).toFixed(1)}% → ${(currentNaive * 100).toFixed(1)}%)`);
  }
  if (combinedFell) {
    parts.push(`scoped+onDisk coverage fell (${(previousCombined * 100).toFixed(1)}% → ${(currentCombined * 100).toFixed(1)}%)`);
  }

  return [{
    name: 'Data: SERP census recall regression',
    status: 'warn',
    message: `Census recall arm regression — ${parts.join('; ')}.`,
    hint: 'Review data/audit/serp-census-recall-history.json + latest data/audit/serp-census-recall.json (missedByCensus/newFromNaive per show). Likely a broken census arm (#647-class) or a new junk-host false positive.',
  }];
}

module.exports = { censusRecallTrendResults, NAIVE_DROP_THRESHOLD_PP, TREND_WINDOW };
