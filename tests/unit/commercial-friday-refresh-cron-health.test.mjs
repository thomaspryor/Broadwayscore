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

// Regex requires the guard and its use to be the SAME expression, not just
// present anywhere in the file (a bare separate `timeBudget.remainingMs()`
// call elsewhere in the file, e.g. a log line, would satisfy a looser match
// without actually gating the loop).
const START_GUARD_RE = /timeBudget\.enabled\s*&&\s*timeBudget\.remainingMs\(\)\s*<\s*MIN_REMAINING_MS_TO_START/;

test('scrape-recoupment-announcements.js supports --time-budget-min via the shared run-budget helper', () => {
  const src = fs.readFileSync(
    new URL('../../scripts/scrape-recoupment-announcements.js', import.meta.url),
    'utf8'
  );
  assert.match(src, /require\(['"]\.\/lib\/run-budget['"]\)/, 'must use the shared run-budget helper (not a bespoke timer)');
  assert.match(
    src,
    START_GUARD_RE,
    'must gate the per-show loop on a proactive remaining-time check (MIN_REMAINING_MS_TO_START), not a bare exceeded() check — no per-show call (SERP + fetchPage + LLM classify) has its own combined timeout, so a show starting right at the deadline can still run minutes over'
  );
  const guardValue = src.match(/MIN_REMAINING_MS_TO_START\s*=\s*(\d+)\s*\*\s*60_000/);
  assert.ok(guardValue, 'MIN_REMAINING_MS_TO_START must be defined as N * 60_000 (minutes)');
  assert.ok(Number(guardValue[1]) >= 1, 'guard must reserve at least 1 full minute, not an ~0 threshold that never actually fires early');
});

test('reconcile-recoupment-claims.js also gates its per-entry loop on the same proactive guard (BRO-2303 follow-up)', () => {
  const src = fs.readFileSync(
    new URL('../../scripts/reconcile-recoupment-claims.js', import.meta.url),
    'utf8'
  );
  assert.match(
    src,
    START_GUARD_RE,
    'verifyClaim() has the identical unbounded-per-entry-cost shape (SERP + fetchPage + LLM classify) as scrape-recoupment-announcements.js\'s per-show loop, and is budgeted by both commercial-friday.yml (12min slice) and commercial-weekly.yml (25min slice) — it needs the same start guard, not just exceeded()'
  );
});
