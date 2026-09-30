// TESTS-VS-DERIVED-DATA-EXEMPT: purely structural — reads the real
// .github/workflows/test.yml CI config, not data/*.json.
/**
 * BRO-4443 — every test.yml job's timeout-minutes must cover its measured
 * runtime PLUS a worst-case actions/checkout stall.
 *
 * A job that hits its own timeout reports `cancelled`, and one cancelled job
 * makes the whole test.yml run `cancelled` — which ci-green-rate.js counts as
 * red. On 2026-09-30 two main runs (36750754558, 36751787270) went red that
 * way with every test passing: Checkout took 9m14s in Unit Tests (normal ~20s,
 * job cancelled at 22.6 of 20 min) and 3m44s in Design Token Drift Guard
 * (cancelled at its 3-min cap). The same class hit lint-workflows (2026-08-14)
 * and awards-data-freshness (2026-08-15) one job at a time. This pins the rule
 * for every job at once, so a new job or a tightened budget fails here instead
 * of on main.
 *
 * Timeouts only bound the worst case, so headroom is free. Hung tests are
 * bounded by per-step `timeout 180` / --test-timeout, not by the job budget.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readWorkflowJobBlocks, jobTimeoutMinutes } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_YML = path.join(__dirname, '..', '..', '.github', 'workflows', 'test.yml');

// Worst observed actions/checkout duration on a test.yml job (run 36750754558,
// Unit Tests, 2026-09-30). Raise it when a slower one is observed.
const CHECKOUT_STALL_SEC = 554;

// Worst GREEN runtime per job (seconds), measured from main runs 2026-09-28..30
// (e.g. run 36712608792 for the full job set; Unit Tests max over 25 runs).
// A new job must be added here with its measured runtime.
const MEASURED_RUNTIME_SEC = {
  'lint-workflows': 114,
  'awards-data-freshness': 24,
  'design-tokens-lint': 30,
  'typescript-check': 108,
  'unit-tests': 852,
  'data-safety-guards': 168,
  'data-validation': 318,
  'e2e-tests': 294,
  'visual-regression': 180,
};

// Jobs deliberately outside the rule, with the reason.
const EXEMPT = {
  // Aggregates needs.* results in seconds; no checkout-bound work to protect.
  'test-summary': 'aggregator job, no timeout-minutes (GitHub default)',
  // Schedule/dispatch only (never on push, so never reds main), and BRO-4434
  // landing B deletes the job; leave its budget to that change.
  'dependency-audit': 'schedule-only; removed by BRO-4434 landing B',
};

const blocks = readWorkflowJobBlocks(fs.readFileSync(TEST_YML, 'utf8'));

test('test.yml: every job is either budget-checked or explicitly exempt', () => {
  const unknown = Object.keys(blocks).filter(
    (job) => !(job in MEASURED_RUNTIME_SEC) && !(job in EXEMPT),
  );
  assert.deepEqual(
    unknown,
    [],
    `new test.yml job(s) ${unknown.join(', ')}: add a measured runtime to MEASURED_RUNTIME_SEC (or an EXEMPT reason)`,
  );
});

for (const [job, runtimeSec] of Object.entries(MEASURED_RUNTIME_SEC)) {
  test(`test.yml ${job}: timeout-minutes covers measured runtime + checkout stall`, () => {
    assert.ok(blocks[job], `job ${job} not found in test.yml — update MEASURED_RUNTIME_SEC`);
    const timeoutMin = jobTimeoutMinutes(blocks[job]);
    assert.ok(timeoutMin, `${job} must declare a job-level timeout-minutes`);
    const needSec = runtimeSec + CHECKOUT_STALL_SEC;
    assert.ok(
      timeoutMin * 60 >= needSec,
      `${job}: timeout-minutes ${timeoutMin} (${timeoutMin * 60}s) < runtime ${runtimeSec}s + checkout stall ${CHECKOUT_STALL_SEC}s = ${needSec}s. A slow checkout will cancel this job and red main (BRO-4443).`,
    );
  });
}
