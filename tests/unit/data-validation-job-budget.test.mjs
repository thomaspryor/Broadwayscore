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
const PUSH_WITH_RETRY_SH = path.join(__dirname, '..', '..', 'scripts', 'lib', 'push-with-retry.sh');

// Measured on run 33410708893 (2026-08-31, the exact cancelled run BRO-2627
// cites): Checkout 569s + every OTHER step in the job except the budgeted
// Playbill audit (checkout-core-data, checkout-review-texts, npm ci, 40+
// fast structural/contamination audits, Commit scraper-spend ledger, etc.)
// summed to ~366s. These are the job's fixed, not-separately-budgeted cost;
// the Playbill step's own cost is bounded by its --time-budget-min flag
// instead, checked separately below.
//
// This constant deliberately EXCLUDES the "Persist venue/date audit rotation
// state (BRO-2695)" step: that step did not exist on run 33410708893 (BRO-2706
// — it was added after this baseline was measured, and the constant here was
// never revisited). Its cost is derived, not folded into this baseline —
// see pushStepWorstCaseSec() below — specifically so that a FUTURE new step
// carrying its own push-with-retry.sh budget doesn't repeat the same drift:
// bumping the shared PUSH_DEADLINE_SEC/GIT_NET_TIMEOUT_SEC defaults, or
// adding a per-step override, changes this test's model automatically instead
// of requiring someone to remember to hand-edit a second number here.
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

// Step boundaries within a job are every `- name:` line at 6-space indent
// (job header at 2, `steps:` at 4, each step's `- name:` at 6).
function findStepStarts(jobLines) {
  const starts = [];
  for (let i = 0; i < jobLines.length; i++) {
    if (/^ {6}- name:/.test(jobLines[i])) starts.push(i);
  }
  return starts;
}

function findStepBlock(jobLines, nameSubstring) {
  const starts = findStepStarts(jobLines);
  for (let i = 0; i < starts.length; i++) {
    if (jobLines[starts[i]].includes(nameSubstring)) {
      const end = i + 1 < starts.length ? starts[i + 1] : jobLines.length;
      return jobLines.slice(starts[i], end);
    }
  }
  return null;
}

// Reads a push-with-retry.sh `VAR=${VAR:-N}` default straight from the real
// script, so a future change to its defaults is picked up automatically
// instead of needing a matching hand-edit here.
function pushWithRetryDefault(varName) {
  const raw = fs.readFileSync(PUSH_WITH_RETRY_SH, 'utf8');
  const m = raw.match(new RegExp(`^${varName}=\\$\\{${varName}:-(\\d+)\\}`, 'm'));
  assert.ok(m, `push-with-retry.sh must declare a default for ${varName}`);
  return parseInt(m[1], 10);
}

// Worst-case wall-clock a step calling push-with-retry.sh can burn: its own
// PUSH_DEADLINE_SEC (default, or a per-step env override) PLUS one more
// GIT_NET_TIMEOUT_SEC — the deadline is only checked BETWEEN retry attempts
// (scripts/lib/push-with-retry.sh), so an attempt already in flight when the
// deadline fires can run up to one more full net-timeout past it before the
// step actually exits (BRO-2706: observed ~311s against a 240s deadline on
// run 33459866223).
function pushStepWorstCaseSec(stepLines, stepLabel) {
  assert.ok(
    stepLines.some((l) => l.includes('push-with-retry.sh')),
    `${stepLabel} step must invoke push-with-retry.sh (or this budget model needs updating)`,
  );
  const overrideLine = stepLines.find((l) => /^\s*PUSH_DEADLINE_SEC\s*:/.test(l));
  const deadlineSec = overrideLine
    ? parseInt(overrideLine.trim().split(':')[1].trim().replace(/['"]/g, ''), 10)
    : pushWithRetryDefault('PUSH_DEADLINE_SEC');
  const netTimeoutSec = pushWithRetryDefault('GIT_NET_TIMEOUT_SEC');
  return deadlineSec + netTimeoutSec;
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

test('data-validation job: fixed step cost + the budgeted step\'s own cap + the BRO-2695 persist step\'s push worst-case fit inside timeout-minutes with headroom', () => {
  const jobLines = readJobBlock('data-validation');
  assert.ok(jobLines, 'could not find the data-validation: job in test.yml');

  const timeoutMin = jobTimeoutMinutes(jobLines);
  const runLine = findVenueAuditRunLine(jobLines);
  const m = runLine && runLine.match(/--time-budget-min=(\d+(?:\.\d+)?)/);
  assert.ok(m, 'expected --time-budget-min= on the Playbill audit step (see the sibling test)');
  const budgetSec = parseFloat(m[1]) * 60;

  const persistStepLines = findStepBlock(jobLines, 'Persist venue/date audit rotation state');
  assert.ok(
    persistStepLines,
    'expected the BRO-2695 "Persist venue/date audit rotation state" step in the data-validation job — ' +
      'if it was removed, delete this line from the model too',
  );
  const persistWorstCaseSec = pushStepWorstCaseSec(
    persistStepLines,
    'Persist venue/date audit rotation state',
  );

  const projectedTotalSec = MEASURED_FIXED_COST_SEC + budgetSec + persistWorstCaseSec;
  const timeoutSec = timeoutMin * 60;
  const headroomSec = timeoutSec - projectedTotalSec;

  assert.ok(
    headroomSec >= timeoutSec * MIN_HEADROOM_FRACTION,
    `projected job time ${projectedTotalSec}s (fixed ${MEASURED_FIXED_COST_SEC}s + Playbill budget ${budgetSec}s ` +
      `+ persist-step worst-case ${persistWorstCaseSec}s) leaves only ${headroomSec}s headroom against a ` +
      `${timeoutSec}s (${timeoutMin}min) budget — need >= ${(timeoutSec * MIN_HEADROOM_FRACTION).toFixed(0)}s. ` +
      'Either the job timeout-minutes shrank, --time-budget-min grew, or a push-with-retry.sh step\'s ' +
      'deadline grew, without matching headroom.',
  );
});
