#!/usr/bin/env node
/**
 * check-cross-outlet-attribution-drift.js — card #1550 (Notion 3bd637c5-416f-81b0).
 *
 * audit-cross-outlet-attributions.test.mjs's four assertions (base scan,
 * --include-fulltext, --playbill-bleed, and the wrongAttribution-contradiction
 * guard) only ran when someone manually invoked them or edited the audited
 * script itself (test.yml path-lists the .js file, not a schedule) — the
 * count silently drifted from 0 to 11 suspects between two manual recheck
 * sessions (task #1006). This runs that test file on the daily
 * data-health-check.yml cron (which already checks out data/review-texts)
 * and persists a snapshot health-check.js's digest can read.
 *
 * SHADOW: reports only, never fixes or reopens anything — drift is expected
 * as new reviews arrive; a hard CI gate would redden main on legitimate data,
 * not a regression.
 *
 *   node scripts/check-cross-outlet-attribution-drift.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const TEST_FILE = path.join('scripts', 'audit-cross-outlet-attributions.test.mjs');
const SNAPSHOT_PATH = path.join(REPO, 'data', 'audit', 'cross-outlet-attribution-drift.json');
const OUTPUT_TAIL_CHARS = 4000; // enough for a failed assertion's diff, not the whole TAP log

function runTest() {
  try {
    const stdout = execFileSync(
      process.execPath,
      ['--test', '--test-timeout', '120000', TEST_FILE],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { exitCode: 0, output: stdout };
  } catch (err) {
    // node --test exits non-zero on any failing/skipped-as-failed assertion;
    // stdout still carries the full TAP/spec report with the failure detail.
    return { exitCode: typeof err.status === 'number' ? err.status : 1, output: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

// Reporter-agnostic (TAP on Node 20, spec on Node 22+ — same gotcha test.yml's
// own node-batch runner works around): match both `# skipped N` and `ℹ skipped N`.
function parseCount(output, label) {
  const m = new RegExp(`^[#ℹ] ${label} (\\d+)`, 'm').exec(output);
  return m ? Number(m[1]) : null;
}

function main() {
  const { exitCode, output } = runTest();
  const passed = exitCode === 0;
  const total = parseCount(output, 'tests');
  const skipped = parseCount(output, 'skipped');
  const allSkipped = total !== null && skipped !== null && skipped === total;
  const snapshot = {
    updatedAt: new Date().toISOString(),
    exitCode,
    passed,
    allSkipped,
    total,
    skipped,
    outputTail: output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output,
  };
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  if (allSkipped) {
    console.log('cross-outlet attribution drift check: SKIPPED (data/review-texts not present in this checkout)');
  } else if (passed) {
    console.log('cross-outlet attribution drift check: PASS (no unreviewed suspects)');
  } else {
    console.log(`cross-outlet attribution drift check: FAIL (exit ${exitCode}) — snapshot written to ${path.relative(REPO, SNAPSHOT_PATH)}`);
  }
  // Never fails the step — this is a shadow-mode report. The digest check in
  // health-check.js is what surfaces drift to a human.
  process.exitCode = 0;
}

module.exports = { parseCount };

if (require.main === module) main();
