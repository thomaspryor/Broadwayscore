#!/usr/bin/env node
'use strict';

/**
 * backtest-cost-index.js — BRO-4989 step 6. Predicts each later public weekly
 * cost figure from the same show's earlier one, carried by the Broadway cost
 * index, and reports the error. Owner's hard stop: if the median error is
 * over ~15%, do not ship (exit 2).
 *
 *   node scripts/backtest-cost-index.js [--json]
 *
 * Sources: data/cost-anchor-seeds.json (researched, dated, same-show series)
 * plus any commercial.json costHistory series with 2+ anchors (Boring Waltz
 * posts, once backfilled). Migrated legacy anchors are skipped: their dates
 * are inferred, so they cannot test the index.
 */

const { backtest, loadSeries, MAX_MEDIAN_ERROR } = require('./lib/cost-index-backtest');

function main() {
  const res = backtest(loadSeries());
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    for (const p of res.pairs) console.log(`  ${p.slug}: ${p.from} -> predicts $${p.predicted} for ${p.to}  error ${(p.error * 100).toFixed(1)}%`);
    for (const b of res.bounds) console.log(`  ${b.slug}: ${b.from} -> predicts $${b.predicted}; source says over ${b.to}: ${b.ok ? 'ok' : 'MISS'}`);
    console.log(`Point pairs: ${res.pairs.length}, floor checks: ${res.bounds.length} (${res.bounds.filter((b) => b.ok).length} ok)`);
    console.log(`Median absolute error: ${res.medianAbsError === null ? 'n/a' : (res.medianAbsError * 100).toFixed(1) + '%'} (stop above ${MAX_MEDIAN_ERROR * 100}%)`);
  }
  if (res.medianAbsError === null) { console.error('No backtest pairs.'); process.exit(1); }
  if (res.medianAbsError > MAX_MEDIAN_ERROR || res.bounds.some((b) => !b.ok)) {
    console.error('STOP: cost index fails the backtest; do not ship (BRO-4989).');
    process.exit(2);
  }
}

if (require.main === module) main();
