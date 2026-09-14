import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadWorkflow, findStep } from '../helpers/workflow-push-timeout.mjs';

/**
 * BRO-2303: Commercial Friday Refresh was stale 3+ consecutive weeks. Root
 * cause was a timeout-cancellation, not a failure: scrape-recoupment-announcements.js's
 * unbounded per-show loop overran the job's 45min timeout-minutes (run
 * 34658940127 — 43min inside "Scan for recoupment announcements" alone), and
 * GitHub reports a timeout-killed job as `cancelled`, which notify-failure's
 * `if: failure()` never sees. Same root-cause class as BRO-2285
 * (batch-commercial-research.js). Fix: give both unbounded per-show loops in
 * this workflow a wall-clock --time-budget-min so they stop cleanly before
 * the job timeout, and size the job timeout with real headroom.
 */

test('commercial-friday recoupment-scan job timeout has headroom over the scan+reconcile budgets', () => {
  const doc = loadWorkflow('commercial-friday.yml');
  const job = doc.jobs['recoupment-scan'];
  assert.ok(job, 'recoupment-scan job must exist');
  assert.ok(
    job['timeout-minutes'] > 45,
    `job timeout-minutes (${job['timeout-minutes']}) must be raised above the original 45 that was getting hit`
  );
});

test('commercial-friday "Scan for recoupment announcements" step is wall-clock budgeted', () => {
  const step = findStep(loadWorkflow('commercial-friday.yml'), 'recoupment-scan', 'Scan for recoupment announcements');
  assert.match(step.run, /--time-budget-min=\d+/, 'scan step must pass --time-budget-min to scrape-recoupment-announcements.js');
});

test('commercial-friday "Reconcile recoupment claim queue" step is wall-clock budgeted', () => {
  const step = findStep(loadWorkflow('commercial-friday.yml'), 'recoupment-scan', 'Reconcile recoupment claim queue');
  assert.match(step.run, /--time-budget-min=\d+/, 'reconcile step must pass --time-budget-min to reconcile-recoupment-claims.js');
});

test('scrape-recoupment-announcements.js supports --time-budget-min via the shared run-budget helper', () => {
  const src = fs.readFileSync(
    new URL('../../scripts/scrape-recoupment-announcements.js', import.meta.url),
    'utf8'
  );
  assert.match(src, /require\(['"]\.\/lib\/run-budget['"]\)/, 'must use the shared run-budget helper (not a bespoke timer)');
  assert.match(src, /timeBudget\.exceeded\(\)/, 'must check the budget inside the per-show loop');
});
