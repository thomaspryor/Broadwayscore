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
 * Sources: data/cost-anchor-ledger.json (BRO-5018 qualifying evidence) and
 * data/cost-anchor-seeds.json (researched, dated, same-show series)
 * plus any commercial.json costHistory series with 2+ anchors (Boring Waltz
 * posts, once backfilled). Migrated legacy anchors are skipped: their dates
 * are inferred, so they cannot test the index.
 * The exploratory series can include estimates. Its median does not satisfy
 * BRO-5018: the sourced ledger separately needs ten pairs in each era.
 */

const { backtest, loadSeries, MAX_MEDIAN_ERROR } = require('./lib/cost-index-backtest');
const { loadLedger, evaluateLedger } = require('./lib/cost-anchor-ledger');

function main() {
  const res = { ...backtest(loadSeries()), anchorLedger: evaluateLedger(loadLedger()) };
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 2));
  else {
    for (const p of res.pairs) console.log(`  ${p.slug}: ${p.from} -> predicts $${p.predicted} for ${p.to}  error ${(p.error * 100).toFixed(1)}%`);
    for (const b of res.bounds) console.log(`  ${b.slug}: ${b.from} -> predicts $${b.predicted}; source says over ${b.to}: ${b.ok ? 'ok' : 'MISS'}`);
    console.log(`Point pairs: ${res.pairs.length}, floor checks: ${res.bounds.length} (${res.bounds.filter((b) => b.ok).length} ok)`);
    console.log(`Median absolute error: ${res.medianAbsError === null ? 'n/a' : (res.medianAbsError * 100).toFixed(1) + '%'} (stop above ${MAX_MEDIAN_ERROR * 100}%)`);
    console.log('BRO-5018 sourced anchor ledger (separate from the exploratory series above):');
    for (const [era, row] of Object.entries(res.anchorLedger.byEra)) {
      console.log(`  ${era}: ${row.pairs}/${res.anchorLedger.minimumPerEra} pairs; missing ${row.missing}; median absolute error ${row.medianAbsError === null ? 'n/a' : (row.medianAbsError * 100).toFixed(1) + '%'}`);
    }
    console.log(`Ledger coverage: ${res.anchorLedger.coverageReady ? 'complete' : 'INCOMPLETE'}. Coverage does not authorize datedCosts promotion; a no-worse recoupment backtest with zero new false recoupments is also required.`);
  }
  if (!res.anchorLedger.coverageReady) {
    console.error('STOP: sourced anchor ledger needs at least 10 pairs per era (BRO-5018); datedCosts cannot be reconsidered on this evidence.');
    process.exitCode = 2;
  }
  if (!res.anchorLedger.indexPass) {
    console.error('STOP: sourced ledger has an empty era or an era median error above the cost-index limit.');
    process.exitCode = 2;
  }
  if (res.medianAbsError === null) { console.error('No backtest pairs.'); process.exit(1); }
  if (res.medianAbsError > MAX_MEDIAN_ERROR || res.bounds.some((b) => !b.ok)) {
    console.error('STOP: cost index fails the backtest; do not ship (BRO-4989).');
    process.exit(2);
  }
}

if (require.main === module) main();
