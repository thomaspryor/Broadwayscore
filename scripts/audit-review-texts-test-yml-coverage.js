#!/usr/bin/env node
/**
 * Advisory guard (task #1760): flag scripts named in
 * tests/unit/review-texts-dir-resolution.test.mjs's MIGRATED_SCRIPTS array
 * that have no matching entry in test.yml's `on.push.paths` allow-list.
 *
 * Background: task #1749 migrated 12 scripts to call resolveReviewTextsDir()
 * instead of hardcoding a stale legacy clone path. 8 of the 12 were missing
 * from test.yml's push-path allow-list — a solo push touching only one of
 * those scripts triggered ZERO CI, silently bypassing the regression test
 * that pins each script to the shared resolver. Fixed manually in 808c40b7c6c,
 * but nothing stopped it recurring: the array and the allow-list are two
 * independent hand-maintained lists with no automated linkage, and it already
 * happened twice mid-task when new scripts were added to the array without a
 * matching test.yml entry.
 *
 * Non-blocking by design (same rationale as scripts/audit-test-yml-lib-deps.js):
 * MIGRATED_SCRIPTS is parsed with a regex-based array-literal scan, not a JS
 * parser, so a hand-edit outside its usual shape could confuse it. Runs
 * advisory in the lint-workflows job.
 *
 * Usage:
 *   node scripts/audit-review-texts-test-yml-coverage.js            # human-readable, exit 0 always
 *   node scripts/audit-review-texts-test-yml-coverage.js --json      # JSON output for CI/scripts
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readPushPaths, isCovered } = require('./audit-test-yml-lib-deps.js');

const ROOT = path.resolve(__dirname, '..');
const TEST_FILE = path.join(ROOT, 'tests', 'unit', 'review-texts-dir-resolution.test.mjs');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test.yml');

/** Extract the string literals inside the `const MIGRATED_SCRIPTS = [...]`
 * array literal. Only quoted entries (one per line, matching the file's own
 * convention) are collected — a line-oriented scan, not a JS parser, so it
 * stops at the first `]` that closes the array. */
function parseMigratedScripts(testSource) {
  const startIdx = testSource.indexOf('const MIGRATED_SCRIPTS = [');
  if (startIdx === -1) throw new Error("could not find 'const MIGRATED_SCRIPTS = [' in review-texts-dir-resolution.test.mjs");
  const closeIdx = testSource.indexOf('];', startIdx);
  if (closeIdx === -1) throw new Error('could not find closing `];` for MIGRATED_SCRIPTS');
  const body = testSource
    .slice(startIdx, closeIdx)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const entries = [];
  const ENTRY_RE = /'([^']+)'/g;
  let m;
  while ((m = ENTRY_RE.exec(body))) entries.push(m[1]);
  return entries;
}

function findGaps({ testSource, ymlSource } = {}) {
  const src = testSource !== undefined ? testSource : fs.readFileSync(TEST_FILE, 'utf8');
  const yml = ymlSource !== undefined ? ymlSource : fs.readFileSync(WORKFLOW, 'utf8');
  const scripts = parseMigratedScripts(src);
  const pathEntries = readPushPaths(yml);

  const gaps = [];
  for (const name of scripts) {
    const repoRel = `scripts/${name}`;
    if (!isCovered(repoRel, pathEntries)) gaps.push(repoRel);
  }
  return gaps;
}

function main() {
  const asJson = process.argv.includes('--json');
  try {
    const gaps = findGaps();
    if (asJson) {
      console.log(JSON.stringify({ gaps }, null, 2));
    } else if (gaps.length === 0) {
      console.log('audit-review-texts-test-yml-coverage: no gaps found — every MIGRATED_SCRIPTS entry is in test.yml\'s push-path allow-list.');
    } else {
      console.log(`::warning::audit-review-texts-test-yml-coverage: ${gaps.length} script(s) in MIGRATED_SCRIPTS are NOT in test.yml's on.push.paths allow-list (a solo push touching only that file triggers zero CI):`);
      for (const g of gaps) console.log(`  ${g}`);
      console.log('Add the missing path(s) to on.push.paths in .github/workflows/test.yml.');
    }
  } catch (err) {
    // The MIGRATED_SCRIPTS/push-paths parsing is a regex heuristic, not a JS
    // parser (see file header) — a hand-edit outside its usual shape, or any
    // other error anywhere in this function, must degrade to a warning, not
    // an uncaught throw, or this "always exits 0" advisory guard would itself
    // start failing CI (card #1918 pattern-recognition finding, 2026-08-26 —
    // the original try only wrapped findGaps(), leaving the render block
    // below it unguarded).
    console.log(`::warning::audit-review-texts-test-yml-coverage: could not complete (${err.message}) — skipping this run.`);
  }
  process.exit(0); // advisory — never fails CI (see file header)
}

module.exports = { parseMigratedScripts, findGaps };

if (require.main === module) main();
