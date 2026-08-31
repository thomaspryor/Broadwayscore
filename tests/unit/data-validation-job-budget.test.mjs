// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the real
// .github/workflows/test.yml CI config (not data/*.json derived data) to
// regression-guard a workflow-timeout fix.
/**
 * BRO-2627 — the `data-validation` job's step-time sum was measured (run
 * 33410708893, 2026-08-31) at ~1816s, essentially AT its 30-minute
 * timeout-minutes budget, so ordinary per-run variance (mostly Checkout,
 * 569s that run) tipped it into CANCELLED before its final steps ran
 * ("Commit scraper-spend ledger" showed cancelled, "Post Setup Node.js"
 * skipped). Worse, a job-level timeout reports CANCELLED, not FAILED,
 * which reads as cascade-cancel and hides a genuine step failure
 * underneath it (BRO-2611 wasted its analysis on exactly that misreading).
 *
 * Fix: the dominant step ("Validate provisional show venue+dates against
 * Playbill", 881s / 14.7min of the total — it re-fetches every provisional
 * show's Playbill page every push) now takes --time-budget-min (scripts/
 * lib/run-budget.js — the same pattern this repo's weekly scraper crons use
 * for unbounded backlogs) instead of running unbounded.
 *
 * This test asserts the OR the ticket's acceptance criteria calls for: the
 * job's steps fit inside its timeout-minutes budget (checked against a
 * measured baseline for the steps NOT covered by an explicit budget), AND
 * the long step carries that explicit per-step budget flag — so a future
 * edit can't silently drop either half and reintroduce the timeout.
 *
 * Pattern: require() the real parser (CLAUDE.md rule 15) — never
 * re-implement workflow-YAML parsing in the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { indentOf, findJobBoundaries } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_YML = path.join(__dirname, '..', '..', '.github', 'workflows', 'test.yml');

// Measured on run 33410708893 (2026-08-31, the exact cancelled run BRO-2627
// cites): Checkout 569s + every OTHER step in the job except the budgeted
// Playbill audit (checkout-core-data, checkout-review-texts, npm ci, 40+
// fast structural/contamination audits, Commit scraper-spend ledger, etc.)
// summed to ~366s. These are the job's fixed, not-separately-budgeted cost;
// the Playbill step's own cost is bounded by its --time-budget-min flag
// instead, checked separately below.
const MEASURED_FIXED_COST_SEC = 569 + 366;
// Require at least 15% slack between the fixed cost + the step's budget and
// the job's declared ceiling — catches a future timeout-minutes cut or a
// --time-budget-min raise that quietly re-creates a tight-budget flake,
// without hardcoding an exact number that has to be updated every edit.
const MIN_HEADROOM_FRACTION = 0.15;

function readJobBlock(jobName) {
  const raw = fs.readFileSync(TEST_YML, 'utf8');
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  assert.notEqual(jobsIdx, -1, 'test.yml must have a top-level jobs: key');
  const jobStarts = findJobBoundaries(lines, jobsIdx);
  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const name = lines[start].trim().replace(/:\s*$/, '');
    if (name === jobName) {
      return lines.slice(start, jobStarts[j + 1]);
    }
  }
  return null;
}

function jobTimeoutMinutes(jobLines) {
  const headerIndent = indentOf(jobLines[0]);
  const line = jobLines.find(
    (l) => indentOf(l) === headerIndent + 2 && /^\s*timeout-minutes\s*:\s*\d+/.test(l),
  );
  assert.ok(line, 'data-validation job must declare an explicit timeout-minutes');
  return parseInt(line.trim().split(':')[1].trim(), 10);
}

function findVenueAuditRunLine(jobLines) {
  return jobLines.find(
    (l) => l.includes('scripts/validate-show-venue.js') && l.includes('--all-provisional'),
  );
}

test('data-validation job: the provisional-venue Playbill audit carries an explicit --time-budget-min', () => {
  const jobLines = readJobBlock('data-validation');
  assert.ok(jobLines, 'could not find the data-validation: job in test.yml');

  const runLine = findVenueAuditRunLine(jobLines);
  assert.ok(
    runLine,
    'expected a run: line invoking validate-show-venue.js --all-provisional in the data-validation job',
  );

  const m = runLine.match(/--time-budget-min=(\d+(?:\.\d+)?)/);
  assert.ok(
    m,
    `validate-show-venue.js --all-provisional must carry --time-budget-min= (BRO-2627) — got: ${runLine.trim()}`,
  );

  // Still a real gate — --fail-on-mismatch must not have been dropped while
  // wiring the budget flag in.
  assert.ok(runLine.includes('--fail-on-mismatch'), 'the audit must still fail the step on a real mismatch');
});

test('data-validation job: fixed step cost + the budgeted step\'s own cap fit inside timeout-minutes with headroom', () => {
  const jobLines = readJobBlock('data-validation');
  assert.ok(jobLines, 'could not find the data-validation: job in test.yml');

  const timeoutMin = jobTimeoutMinutes(jobLines);
  const runLine = findVenueAuditRunLine(jobLines);
  const m = runLine && runLine.match(/--time-budget-min=(\d+(?:\.\d+)?)/);
  assert.ok(m, 'expected --time-budget-min= on the Playbill audit step (see the sibling test)');
  const budgetSec = parseFloat(m[1]) * 60;

  const projectedTotalSec = MEASURED_FIXED_COST_SEC + budgetSec;
  const timeoutSec = timeoutMin * 60;
  const headroomSec = timeoutSec - projectedTotalSec;

  assert.ok(
    headroomSec >= timeoutSec * MIN_HEADROOM_FRACTION,
    `projected job time ${projectedTotalSec}s leaves only ${headroomSec}s headroom against a ` +
      `${timeoutSec}s (${timeoutMin}min) budget — need >= ${(timeoutSec * MIN_HEADROOM_FRACTION).toFixed(0)}s. ` +
      'Either the job timeout-minutes shrank or --time-budget-min grew without matching headroom.',
  );
});
