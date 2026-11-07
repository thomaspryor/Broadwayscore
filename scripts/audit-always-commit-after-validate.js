#!/usr/bin/env node
/**
 * audit-always-commit-after-validate.js (BRO-5293) — ADVISORY, always exits 0.
 *
 * Lists workflow jobs where a commit/push step that stages data/ files still
 * runs after a failed validate-data.js step (`if: always()` / `failure()` /
 * `!cancelled()`, or a soft validate step) and never checks that step's
 * outcome. Fix shape: see generate-theater-tips.yml (BRO-3511). Intentional
 * cases: annotate the commit step `# always-commit-ok: <reason>`.
 * Decision logic: scripts/lib/always-commit-after-validate.js.
 *
 * Usage:
 *   node scripts/audit-always-commit-after-validate.js [--json] [--dir=<workflows dir>]
 *   node scripts/audit-always-commit-after-validate.js --help, -h
 */
'use strict';
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { auditWorkflowDir, unscannableWorkflows } = require('./lib/always-commit-after-validate.js');

const USAGE = `audit-always-commit-after-validate.js — advisory: always() commits that publish data after a failed validate-data.js.

Usage:
  node scripts/audit-always-commit-after-validate.js [--json] [--dir=<workflows dir>]
  node scripts/audit-always-commit-after-validate.js --help, -h    print this usage and exit
`;
const argv = process.argv.slice(2);
if (hasHelpFlag(argv)) { process.stdout.write(USAGE); process.exit(0); }

const dirArg = argv.find((a) => a.startsWith('--dir='));
const dir = dirArg ? path.resolve(dirArg.slice(6)) : path.join(__dirname, '..', '.github', 'workflows');

let hits;
try {
  hits = auditWorkflowDir(dir);
} catch (e) {
  console.log(`::warning::always-commit-after-validate: could not scan ${dir}: ${e.message}`);
  process.exit(0);
}

let unscannable = [];
try { unscannable = unscannableWorkflows(dir); } catch { /* scan above already warned */ }
for (const f of unscannable) console.log(`::warning::always-commit-after-validate: ${f} mentions validate-data.js but parsed to no steps (unsupported layout); not audited`);

if (argv.includes('--json')) {
  process.stdout.write(JSON.stringify({ count: hits.length, offenders: hits }, null, 2) + '\n');
  process.exit(0);
}
if (!hits.length) {
  console.log('always-commit-after-validate: OK (no unguarded always() data commit after validate-data.js)');
  process.exit(0);
}
console.log(`always-commit-after-validate: ${hits.length} advisory finding(s)`);
for (const h of hits) {
  console.log(`- ${h.file}:${h.commitLine} [${h.job}] "${h.commitStep}" stages ${h.staged.join(", ")}; after "${h.validateStep}" :${h.validateLine}; ${h.reason}`);
}
console.log('Fix (BRO-3511 shape): give the validate step an id, pass steps.<id>.outcome into the commit step,');
console.log('and stage validated data files only on success; or annotate `# always-commit-ok: <reason>`.');
process.exit(0);
