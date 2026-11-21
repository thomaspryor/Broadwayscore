#!/usr/bin/env node
/**
 * Writes data/coverage-floor-snapshot.json: the coverage floor's verdicts,
 * stamps and acks (scripts/lib/coverage-floor-inputs.js) in ~200KB instead of
 * the ~10MB of data/audit/ files they come from.
 *
 * Why (BRO-5811): next.config.js excludes data/audit/** from the Vercel server
 * functions, so a show page re-rendered at runtime (revalidate, or a
 * dynamicParams show added after the build) could not read the audits and
 * the floor failed open. next.config.js traces this snapshot instead, and
 * the loader falls back to it when the raw audits are absent.
 *
 * Runs in prebuild (gitignored output). The old snapshot is removed first so
 * a checkout without the raw audits writes an empty snapshot rather than
 * re-publishing a stale one.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  COVERAGE_FLOOR_SNAPSHOT_FILE,
  loadCoverageFloorInputs,
  coverageFloorSnapshot,
} = require('./lib/coverage-floor-inputs');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/build-coverage-floor-snapshot.js\nWrites data/coverage-floor-snapshot.json from data/audit/ (no flags).');
  process.exit(0);
}

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OUT = path.join(DATA_DIR, COVERAGE_FLOOR_SNAPSHOT_FILE);

fs.rmSync(OUT, { force: true });
// Built with the kill switch ignored ({} env): COVERAGE_GATE_DISABLED is
// applied when the snapshot is read, so flipping it back on at runtime works
// without a rebuild.
const snap = coverageFloorSnapshot(loadCoverageFloorInputs(DATA_DIR, {}));
fs.writeFileSync(OUT, JSON.stringify(snap));
// Fail open (Coverage Verdict rule 1: never fail CI hard), but loudly: a CI
// build with no verdicts ships pages that can never hold a score at TBD.
if ((process.env.CI || process.env.VERCEL) && Object.keys(snap.cov).length === 0) {
  console.log('::warning::coverage-floor snapshot has 0 verdicts (data/audit/show-review-gap.json missing or empty); runtime-rendered pages will have no coverage floor');
}
console.log(`[coverage-floor-snapshot] ${Object.keys(snap.cov).length} verdicts, ${Object.keys(snap.stamps).length} stamps, ${snap.acked.length} acks -> data/${COVERAGE_FLOOR_SNAPSHOT_FILE}`);
