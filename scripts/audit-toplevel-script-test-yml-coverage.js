#!/usr/bin/env node
/**
 * Advisory guard (BRO-172 follow-up): flag top-level scripts/*.js files that
 * (a) are registered in tests/unit-test-manifest.txt or
 * tests/unit-test-manifest-tsx.txt (so CI DOES run their test — this is not
 * about untested scripts, most of the 900+ top-level scripts have no test at
 * all by design) but (b) have no matching entry in test.yml's `on.push.paths`
 * push-trigger allow-list, and so a solo push touching only that script (or
 * its colocated test) triggers ZERO CI even though the test exists and would
 * have caught the bug.
 *
 * Background: scripts/fix-platform-ticket-links.js had a region-mismatch bug
 * (Ticketmaster SERP re-verification silently overwrote a West End show's
 * correct ticketmaster.co.uk link with a wrong US ticketmaster.com page) that
 * regressed shows.json at least 6 times in the private data repo's history
 * before anyone noticed, because the script had no test.yml path entry at
 * all — nothing ever ran its logic on push. scripts/lib/** closed this gap
 * class for scripts/lib/ (task #1745); scripts/audit-test-yml-lib-deps.js and
 * scripts/audit-review-texts-test-yml-coverage.js catch two narrower shapes
 * of it. This is the general top-level-scripts/ version: any script sitting
 * in the manifest (proof a test exists and is meant to run in CI) but missing
 * from the push-path allow-list (proof a push touching it will ever fire).
 *
 * Non-blocking by design (same rationale as the sibling audits above):
 * covers manifest entries directly under scripts/ only (not scripts/lib/,
 * already globbed, and not scripts/tests/ or tests/, both broadly globbed by
 * 'tests/**' — see test.yml line ~9). No dependency-chasing: unlike
 * audit-test-yml-lib-deps.js this doesn't parse require()/import, it just
 * checks whether the manifest entry itself (and its sibling source file) is
 * covered by the allow-list.
 *
 * Usage:
 *   node scripts/audit-toplevel-script-test-yml-coverage.js            # human-readable, exit 0 always
 *   node scripts/audit-toplevel-script-test-yml-coverage.js --json      # JSON output for CI/scripts
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readPushPaths, isCovered } = require('./audit-test-yml-lib-deps.js');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');
const MANIFESTS = [
  path.join(ROOT, 'tests', 'unit-test-manifest.txt'),
  path.join(ROOT, 'tests', 'unit-test-manifest-tsx.txt'),
];

// scripts/*.test.(mjs|ts) directly under scripts/ (not scripts/lib/, not
// scripts/tests/) — those two subdirectories already have their own coverage
// (scripts/lib/** glob; tests/** glob covers scripts/tests/ via its own path).
const TOPLEVEL_TEST_RE = /^scripts\/[^/]+\.test\.(mjs|ts)$/;

/** Pure: filter raw manifest lines down to top-level scripts/*.test.(mjs|ts)
 * entries (excludes scripts/lib/, scripts/tests/, tests/, and blank/comment
 * lines). Exported separately from the disk read so it's unit-testable. */
function filterToplevelTestEntries(lines) {
  return lines.map((l) => l.trim()).filter((t) => t && TOPLEVEL_TEST_RE.test(t));
}

function readManifestEntries() {
  const entries = [];
  for (const manifestPath of MANIFESTS) {
    if (!fs.existsSync(manifestPath)) continue;
    const lines = fs.readFileSync(manifestPath, 'utf8').split('\n');
    entries.push(...filterToplevelTestEntries(lines));
  }
  return entries;
}

function siblingSourcePath(testRelPath) {
  // scripts/foo.test.mjs -> scripts/foo.js ; scripts/foo.test.ts -> scripts/foo.ts
  const m = testRelPath.match(/^(scripts\/[^/]+)\.test\.(mjs|ts)$/);
  if (!m) return null;
  const [, stem, ext] = m;
  const candidate = ext === 'ts' ? `${stem}.ts` : `${stem}.js`;
  return fs.existsSync(path.join(ROOT, candidate)) ? candidate : null;
}

function findGaps() {
  const yml = fs.readFileSync(WORKFLOW, 'utf8');
  const pathEntries = readPushPaths(yml);
  const gaps = [];

  for (const testRelPath of readManifestEntries()) {
    const testCovered = isCovered(testRelPath, pathEntries);
    const sourceRelPath = siblingSourcePath(testRelPath);
    const sourceCovered = sourceRelPath ? isCovered(sourceRelPath, pathEntries) : true; // no sibling source = nothing more to check

    if (!testCovered || !sourceCovered) {
      gaps.push({
        test: testRelPath,
        testCovered,
        source: sourceRelPath,
        sourceCovered,
      });
    }
  }
  return gaps;
}

function main() {
  const gaps = findGaps();
  const asJson = process.argv.includes('--json');

  if (asJson) {
    console.log(JSON.stringify({ gaps }, null, 2));
  } else if (gaps.length === 0) {
    console.log('audit-toplevel-script-test-yml-coverage: no gaps found — every manifest-registered top-level scripts/*.test file (and its sibling source) is path-listed in test.yml.');
  } else {
    console.log(`::warning::audit-toplevel-script-test-yml-coverage: ${gaps.length} manifest-registered top-level script test(s) are NOT (fully) covered by test.yml's on.push.paths allow-list (a solo push touching only these files triggers zero CI even though a test exists):`);
    for (const g of gaps) {
      const parts = [];
      if (!g.testCovered) parts.push(`test file ${g.test} missing`);
      if (g.source && !g.sourceCovered) parts.push(`source file ${g.source} missing`);
      console.log(`  ${g.test} -> ${parts.join('; ')}`);
    }
    console.log("Add the missing path(s) to on.push.paths in .github/workflows/test.yml.");
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = { readManifestEntries, filterToplevelTestEntries, siblingSourcePath, findGaps };

if (require.main === module) main();
