#!/usr/bin/env node
/**
 * Regenerate scripts/lib/run-budget-coverage-baseline.json from the current
 * workflows (BRO-3447). Kept out of audit-run-budget-coverage.js because that
 * audit is on the safe-form allowlist and must stay write-free.
 *
 * Usage: node scripts/write-run-budget-coverage-baseline.js
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { collectFindings, findingKey, BASELINE_PATH } = require('./audit-run-budget-coverage');

const { warnings, threadingWarnings, flagWarnings } = collectFindings();
const keys = [...new Set([...warnings, ...threadingWarnings, ...flagWarnings].map(findingKey))].sort();
fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({
  _comment: 'Advisory baseline for scripts/audit-run-budget-coverage.js (BRO-3447). Findings listed here are known; only findings NOT listed fail the colocated unit test. Regenerate with: node scripts/write-run-budget-coverage-baseline.js',
  findings: keys,
}, null, 2)}\n`);
console.log(`Wrote ${keys.length} baseline finding(s) to ${path.relative(process.cwd(), BASELINE_PATH)}`);
