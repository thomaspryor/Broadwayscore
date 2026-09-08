// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the real
// .github/workflows/audit-provisional-venues.yml CI config (not data/*.json
// derived data) to regression-guard a workflow-timeout fix.
/**
 * RETARGETED BY BRO-2984 (2026-09-08). The steps this file models moved OUT of
 * test.yml's `data-validation` job and into the daily
 * `.github/workflows/audit-provisional-venues.yml`, because the Playbill sweep
 * spent real ScrapingBee/Bright Data credits on EVERY push to main (222
 * scraper-spend-ledger rows attributed to workflow "Test Suite" in a ~2-day
 * window). The budget model below is unchanged in substance — it just points at
 * the sweep's new home. Deleting this file instead would have dropped the
 * BRO-2627/BRO-2706 timeout guard along with the move, which is the failure this
 * whole card is about: relocating work must not quietly relocate its guards.
 *
 * BRO-2627 — the job's step-time sum was measured (run
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
const SWEEP_YML = path.join(
  __dirname, '..', '..', '.github', 'workflows', 'audit-provisional-venues.yml',
);
const PUSH_WITH_RETRY_SH = path.join(__dirname, '..', '..', 'scripts', 'lib', 'push-with-retry.sh');

// The audit job's fixed, not-separately-budgeted cost. Rebuilt for this job's
// actual step composition when the sweep moved here (BRO-2984) — the old
// 569 + 366 figure described test.yml's data-validation job, which ran 40+ extra
// audits this job does not, and did NOT run setup-playwright before its own
// npm ci. Components, each sourced rather than guessed:
//   569s  Checkout at fetch-depth 300 — measured on run 33410708893 (2026-08-31,
//         the cancelled run BRO-2627 cites), same action and same repo size.
//   480s  setup-playwright — its own composite action's hard `timeout` ceiling
//         (.github/actions/setup-playwright, "Install Playwright browsers"), so
//         this is a true upper bound, not an average.
//   366s  everything else (setup-node, npm ci, checkout-core-data, the
//         missing-secrets guard, the ledger commit). Deliberately reuses the
//         whole non-Playbill bucket measured on that run even though this job
//         does STRICTLY LESS of it — 40+ audits and a review-texts checkout are
//         gone — so the number stays conservative while remaining sourced.
// The sweep's own cost is bounded by --time-budget-min instead, and the persist
// step's by pushStepWorstCaseSec(); both are checked separately below.
const MEASURED_FIXED_COST_SEC = 569 + 480 + 366;
// Require at least 15% slack between the fixed cost + the step's budget and
// the job's declared ceiling — catches a future timeout-minutes cut or a
// --time-budget-min raise that quietly re-creates a tight-budget flake,
// without hardcoding an exact number that has to be updated every edit.
const MIN_HEADROOM_FRACTION = 0.15;

function readJobBlock(jobName, ymlPath = SWEEP_YML) {
  const raw = fs.readFileSync(ymlPath, 'utf8');
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  assert.notEqual(jobsIdx, -1, `${path.basename(ymlPath)} must have a top-level jobs: key`);
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
  assert.ok(line, 'this job must declare an explicit timeout-minutes');
  return parseInt(line.trim().split(':')[1].trim(), 10);
}

// The sweep step builds its flags in a shell variable
// (`FLAGS="--all-provisional --time-budget-min=$BUDGET_MIN"` … `node
// scripts/validate-show-venue.js $FLAGS`) so that --fail-on-mismatch can be
// toggled by a dispatch input and a non-numeric budget can be rejected before
// it silently disables the budget. That means the invocation and its flags are
// NOT on one physical line, so this returns the step's whole text rather than a
// single line. Returns null when no step invokes the sweep at all.
function findVenueAuditStepText(jobLines) {
  const starts = findStepStarts(jobLines);
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : jobLines.length;
    const block = jobLines.slice(starts[i], end);
    const code = block.filter((l) => !/^\s*#/.test(l)).join('\n');
    if (code.includes('scripts/validate-show-venue.js') && code.includes('--all-provisional')) {
      return code;
    }
  }
  return null;
}

// Read the effective time budget in minutes. Accepts either a literal
// `--time-budget-min=25` on the command, or the indirected form this workflow
// uses: `--time-budget-min=$BUDGET_MIN` with BUDGET_MIN's default supplied by
// `BUDGET_MIN: ${{ github.event.inputs.time_budget_min || '25' }}`. The default
// is what a SCHEDULED run gets (github.event.inputs is null on `schedule`), and
// the scheduled run is the one this budget model is about.
function budgetMinutesFrom(stepText) {
  const literal = stepText.match(/--time-budget-min=(\d+(?:\.\d+)?)\b/);
  if (literal) return parseFloat(literal[1]);
  const viaVar = stepText.match(/--time-budget-min=\$\{?([A-Z_][A-Z0-9_]*)\}?/);
  if (!viaVar) return null;
  const envDefault = stepText.match(
    new RegExp(`${viaVar[1]}\\s*:\\s*\\$\\{\\{[^}]*?\\|\\|\\s*'(\\d+(?:\\.\\d+)?)'`),
  );
  return envDefault ? parseFloat(envDefault[1]) : null;
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

// A line MENTIONING push-with-retry.sh in prose (YAML or shell comments both
// use `#`) is not a step invoking it — e.g. the Checkout step's fetch-depth
// rationale and the "Validate review-text files" step both discuss
// push-with-retry.sh in comments without calling it. Require a non-comment
// line so those aren't misidentified as push-bound steps.
function invokesPushWithRetry(lines) {
  return lines.some((l) => !/^\s*#/.test(l) && l.includes('push-with-retry.sh'));
}

// Steps that were ALREADY invoking push-with-retry.sh (inline, i.e. visible as
// a `run:` line in this job's own YAML) when MEASURED_FIXED_COST_SEC was
// measured on run 33410708893 — their typical cost is already folded into
// that baseline, so they're excluded here to avoid double-counting. Anything
// else found invoking push-with-retry.sh is new since that baseline (code
// review finding, BRO-2706: a name-specific test only catches the ONE step it
// names, not the regression class) and gets modeled automatically below.
// NOTE: "Commit scraper-spend ledger" also calls push-with-retry.sh, but from
// inside a separate composite action (.github/actions/commit-scraper-spend-
// ledger) — its call isn't inline text in this job's YAML, so findAllPush-
// RetrySteps() structurally can't see it either way; it stays folded into the
// fixed baseline like every other pre-existing step.
const BASELINE_PUSH_STEP_NAMES = ['Record pipeline success'];

function findAllPushRetrySteps(jobLines) {
  const starts = findStepStarts(jobLines);
  const steps = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : jobLines.length;
    const lines = jobLines.slice(starts[i], end);
    if (!invokesPushWithRetry(lines)) continue;
    const nameMatch = jobLines[starts[i]].match(/^\s*- name:\s*(.+)$/);
    const name = nameMatch ? nameMatch[1].trim() : `<unnamed step at line ${starts[i]}>`;
    if (BASELINE_PUSH_STEP_NAMES.includes(name)) continue;
    steps.push({ name, lines });
  }
  return steps;
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
//
// Deliberately does NOT add push-via-git-api.sh's fallback cost (up to
// several more minutes past PUSH_DEADLINE_SEC — see push-with-retry.sh's own
// task #1847 comment above its invocation). Verified (code review finding)
// that fallback is structurally disqualified for every step this function is
// currently applied to: each pushes a file under data/audit/ that is NOT in
// core-data-merge-registry.js's API_FALLBACK_SAFE list, which push-with-
// retry.sh's own MANAGED/audit disqualifier check (search
// "_managed_check_rc" in push-with-retry.sh) sets _api_fallback_ok=false for
// before the fallback block ever runs. If a future step this function models
// pushes a DIFFERENT file that IS (or becomes) apiFallbackSafe, this
// assumption breaks silently — no test here catches that combination.
function pushStepWorstCaseSec(stepLines, stepLabel) {
  assert.ok(
    invokesPushWithRetry(stepLines),
    `${stepLabel} step must invoke push-with-retry.sh (or this budget model needs updating)`,
  );
  const overrideLine = stepLines.find((l) => /^\s*PUSH_DEADLINE_SEC\s*:/.test(l));
  const deadlineSec = overrideLine
    ? parseInt(overrideLine.trim().split(':')[1].trim().replace(/['"]/g, ''), 10)
    : pushWithRetryDefault('PUSH_DEADLINE_SEC');
  assert.ok(
    Number.isFinite(deadlineSec),
    `${stepLabel} step: could not parse a numeric PUSH_DEADLINE_SEC override — ` +
      `got: ${overrideLine?.trim()}. This model only understands a plain \`PUSH_DEADLINE_SEC: '<number>'\` ` +
      'env override, not an expression or inline VAR=value form.',
  );
  const netTimeoutSec = pushWithRetryDefault('GIT_NET_TIMEOUT_SEC');
  return deadlineSec + netTimeoutSec;
}

test('audit-provisional-venues: the Playbill sweep carries an explicit --time-budget-min', () => {
  const jobLines = readJobBlock('audit');
  assert.ok(jobLines, 'could not find the audit: job in audit-provisional-venues.yml');

  const stepText = findVenueAuditStepText(jobLines);
  assert.ok(
    stepText,
    'expected a step invoking validate-show-venue.js --all-provisional in the audit job',
  );

  assert.ok(
    budgetMinutesFrom(stepText) > 0,
    `validate-show-venue.js --all-provisional must carry --time-budget-min= (BRO-2627) — got: ${stepText}`,
  );

  // Still a real gate — --fail-on-mismatch must not have been dropped while
  // wiring the budget flag in. It is now conditional on a dispatch input whose
  // default is 'true', which is what a scheduled run always resolves to.
  assert.ok(
    stepText.includes('--fail-on-mismatch'),
    'the audit must still fail on a real mismatch',
  );
  assert.match(
    stepText,
    /FAIL_ON_MISMATCH:\s*\$\{\{[^}]*\|\|\s*'true'/,
    "the fail_on_mismatch input must DEFAULT to 'true' — a scheduled run must be strict",
  );
});

test('audit-provisional-venues: fixed step cost + the budgeted step\'s own cap + the BRO-2695 persist step\'s push worst-case fit inside timeout-minutes with headroom', () => {
  const jobLines = readJobBlock('audit');
  assert.ok(jobLines, 'could not find the audit: job in audit-provisional-venues.yml');

  const timeoutMin = jobTimeoutMinutes(jobLines);
  const stepText = findVenueAuditStepText(jobLines);
  const budgetMin = stepText && budgetMinutesFrom(stepText);
  assert.ok(budgetMin > 0, 'expected --time-budget-min= on the Playbill audit step (see the sibling test)');
  const budgetSec = budgetMin * 60;

  // Sum the worst-case of EVERY inline push-with-retry.sh step not already
  // folded into MEASURED_FIXED_COST_SEC — not just the one BRO-2695 added —
  // so the next new step of this shape is caught the same way, automatically.
  const newPushSteps = findAllPushRetrySteps(jobLines);
  assert.ok(
    newPushSteps.some((s) => s.name.includes('Persist venue/date audit rotation state')),
    'expected the BRO-2695 "Persist venue/date audit rotation state" step in the data-validation job — ' +
      'if it was removed, this model (and its BASELINE_PUSH_STEP_NAMES exclusion list) may need revisiting',
  );
  const newPushStepsWorstCaseSec = newPushSteps.reduce(
    (sum, s) => sum + pushStepWorstCaseSec(s.lines, s.name),
    0,
  );

  const projectedTotalSec = MEASURED_FIXED_COST_SEC + budgetSec + newPushStepsWorstCaseSec;
  const timeoutSec = timeoutMin * 60;
  const headroomSec = timeoutSec - projectedTotalSec;

  assert.ok(
    headroomSec >= timeoutSec * MIN_HEADROOM_FRACTION,
    `projected job time ${projectedTotalSec}s (fixed ${MEASURED_FIXED_COST_SEC}s + Playbill budget ${budgetSec}s ` +
      `+ push-step(s) [${newPushSteps.map((s) => s.name).join(', ')}] worst-case ${newPushStepsWorstCaseSec}s) ` +
      `leaves only ${headroomSec}s headroom against a ${timeoutSec}s (${timeoutMin}min) budget — need >= ` +
      `${(timeoutSec * MIN_HEADROOM_FRACTION).toFixed(0)}s. Either the job timeout-minutes shrank, ` +
      '--time-budget-min grew, or a push-with-retry.sh step\'s deadline grew, without matching headroom.',
  );
});


// ── The ratchet BRO-2984 briefly lost ────────────────────────────────────────
// Retargeting this file to the relocated sweep left test.yml's own
// `data-validation` job with NO budget model at all — and within the same
// change its timeout-minutes was cut 37 -> 25, below that job's real worst
// case, with nothing to catch it. (Caught in review; the cut was reverted.)
// This block restores the ratchet so the same gap cannot reopen. The model
// differs from the sweep's above in one way: that job no longer has a budgeted
// step, so its projection is fixed cost + its push-bound steps alone.

const TEST_YML = path.join(__dirname, '..', '..', '.github', 'workflows', 'test.yml');

// Same two measured components as MEASURED_FIXED_COST_SEC's first and third
// terms (run 33410708893): Checkout at fetch-depth 300, plus the whole
// non-Playbill audit bucket. The 480s setup-playwright term is deliberately
// NOT included — that step moved to audit-provisional-venues.yml with the
// sweep it existed for, and no remaining data-validation step needs a browser.
const DATA_VALIDATION_FIXED_COST_SEC = 569 + 366;

// Steps in data-validation that reach push-with-retry.sh. "Record pipeline
// success" calls it inline; "Commit scraper-spend ledger" calls it from inside
// .github/actions/commit-scraper-spend-ledger, so findAllPushRetrySteps()
// structurally cannot see it — it is counted explicitly here rather than
// silently omitted, which is what made the 25 look survivable.
const DATA_VALIDATION_PUSH_STEP_NAMES = [
  'Record pipeline success',
  'Commit scraper-spend ledger',
];

test('test.yml data-validation: fixed cost + its push-bound steps fit inside timeout-minutes with headroom', () => {
  const jobLines = readJobBlock('data-validation', TEST_YML);
  assert.ok(jobLines, 'could not find the data-validation: job in test.yml');

  const timeoutMin = jobTimeoutMinutes(jobLines);
  const timeoutSec = timeoutMin * 60;

  // Every push-bound step is modelled at the shared default deadline + one
  // in-flight net-timeout overshoot. Neither file it pushes is in
  // core-data-merge-registry.js's API_FALLBACK_SAFE list, so the Git Data API
  // fallback is disqualified for both and the deadline is the real cap.
  // push-mutex.sh's 900s wait is deliberately excluded: its lock lives in the
  // repo's git common dir (or a cwd-keyed /tmp fallback), and Actions runners
  // are fresh per job with sequential steps, so nothing else can hold it.
  const perPushSec = pushWithRetryDefault('PUSH_DEADLINE_SEC') + pushWithRetryDefault('GIT_NET_TIMEOUT_SEC');

  // Match an actual `- name:` STEP line, not any occurrence of the string:
  // both of these names also appear in prose comments in this job, so a
  // `jobText.includes(name)` check would keep passing after the step itself was
  // deleted — the model would then silently describe a job that no longer
  // exists.
  const stepNames = jobLines
    .map((l) => l.match(/^ {6}- name:\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
  for (const name of DATA_VALIDATION_PUSH_STEP_NAMES) {
    assert.ok(
      stepNames.includes(name),
      `expected a "${name}" STEP in data-validation (found steps: ${stepNames.length}) — ` +
        'if it was renamed or removed, this budget model needs updating',
    );
  }
  const pushWorstCaseSec = DATA_VALIDATION_PUSH_STEP_NAMES.length * perPushSec;

  const projectedTotalSec = DATA_VALIDATION_FIXED_COST_SEC + pushWorstCaseSec;
  const headroomSec = timeoutSec - projectedTotalSec;

  assert.ok(
    headroomSec >= timeoutSec * MIN_HEADROOM_FRACTION,
    `projected data-validation time ${projectedTotalSec}s (fixed ${DATA_VALIDATION_FIXED_COST_SEC}s + ` +
      `${DATA_VALIDATION_PUSH_STEP_NAMES.length} push step(s) at ${perPushSec}s each = ${pushWorstCaseSec}s) ` +
      `leaves only ${headroomSec}s headroom against a ${timeoutSec}s (${timeoutMin}min) budget — need >= ` +
      `${(timeoutSec * MIN_HEADROOM_FRACTION).toFixed(0)}s. BRO-2984: this job was cut to 25min once, ` +
      'below its own worst case, and a breach reports CANCELLED (not FAILED) so nothing alerts.',
  );
});

test('test.yml data-validation no longer runs the paid Playbill sweep', () => {
  // The budget above is only defensible while the sweep is gone. If it ever
  // comes back, this model understates the job by ~15 minutes AND the job is
  // spending money on every push again (the BRO-2984 defect itself).
  const jobLines = readJobBlock('data-validation', TEST_YML);
  assert.ok(jobLines, 'could not find the data-validation: job in test.yml');
  assert.equal(
    findVenueAuditStepText(jobLines),
    null,
    'the --all-provisional Playbill sweep is back in test.yml\'s data-validation job — ' +
      'it spends real ScrapingBee/Bright Data credits on every push (BRO-2984)',
  );
});
