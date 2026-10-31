#!/usr/bin/env node
/**
 * BRO-5885 ratchet: fail when any script under scripts/ gains a
 * `statSync(...).isDirectory()` show-dir listing beyond the committed baseline
 * (scripts/lib/unsafe-show-dir-listing-baseline.json). Use listShowDirs()
 * from scripts/lib/list-show-dirs.js instead (a dangling symlink in
 * data/review-texts crashed collection for ~8h on 2026-05-27).
 *
 *   node scripts/audit-unsafe-show-dir-listing.js            # check (exit 1 on regression)
 *   node scripts/audit-unsafe-show-dir-listing.js --update   # rewrite baseline (ratchet down only)
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { scanScripts, compareToBaseline } = require('./lib/unsafe-show-dir-listing');

const ROOT = path.join(__dirname, '..');
const BASELINE = path.join(__dirname, 'lib', 'unsafe-show-dir-listing-baseline.json');

const counts = scanScripts(ROOT);
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  if (baseline) {
    const { regressions } = compareToBaseline(counts, baseline);
    if (regressions.length) {
      console.error('Refusing to raise the baseline; fix these instead:');
      for (const r of regressions) console.error(`  ${r.file}: ${r.baseline} -> ${r.actual}`);
      process.exit(1);
    }
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(BASELINE, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`baseline written: ${Object.keys(sorted).length} files, ${total} unsafe lines`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const { regressions, improvements } = compareToBaseline(counts, baseline);
console.log(`unsafe show-dir listings: ${total} lines in ${Object.keys(counts).length} files (baseline ${Object.keys(baseline).length} files)`);
if (improvements.length) {
  console.log(`${improvements.length} file(s) improved; run with --update to lower the baseline:`);
  for (const i of improvements) console.log(`  ${i.file}: ${i.baseline} -> ${i.actual}`);
}
if (regressions.length) {
  console.error('FAIL: new unsafe fs.statSync(...).isDirectory() listing (throws ENOENT on a dangling symlink). Use listShowDirs(root, { silent: true }) from scripts/lib/list-show-dirs.js:');
  for (const r of regressions) console.error(`  ${r.file}: baseline ${r.baseline}, now ${r.actual}`);
  process.exit(1);
}
console.log('OK: no regressions');
