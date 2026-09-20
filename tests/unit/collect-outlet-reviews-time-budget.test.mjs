// BRO-3887: collect-outlet-reviews.js honours --time-budget-min so the
// outlet-serp job in gather-reviews.yml stops cleanly inside its timeout-minutes
// cap instead of being cancelled at it (20m20s in 3/3 runs sampled 2026-09-19..20,
// which marks the whole run "cancelled" even though every other job succeeded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseTimeBudgetMin } = require('../../scripts/lib/run-budget.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'scripts', 'collect-outlet-reviews.js');

test('parseTimeBudgetMin accepts the EQUALS form the workflow passes and rejects the space form', () => {
  // The space form is the trap: every other flag in collect-outlet-reviews.js's
  // own parseArgs() is space-separated, but run-budget.js only matches `--flag=N`,
  // so `--time-budget-min 16` would parse as 0 and silently disable the budget.
  assert.equal(parseTimeBudgetMin(['--shows', 'a', '--time-budget-min=16']), 16);
  assert.equal(parseTimeBudgetMin(['--shows', 'a', '--time-budget-min', '16']), 0);
  assert.equal(parseTimeBudgetMin(['--shows', 'a']), 0);
});

test('collect-outlet-reviews.js hard-errors on the space form instead of silently no-opping', () => {
  const res = spawnSync(
    process.execPath,
    [SRC, '--shows', 'zzz-fake-show-1', '--time-budget-min', '16'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SCRAPINGBEE_API_KEY: 'test-key' } },
  );
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}\n${out.slice(-1200)}`);
  assert.match(out, /--time-budget-min takes the equals form/, out.slice(-1200));
});

// The end-to-end "budget trips mid-run" path cannot be spawned here: main() reads
// data/shows.json + data/outlet-registry.json, which are private-repo core data
// absent from a bare worktree, and in CI (where checkout-core-data supplies them)
// a fake show id yields zero target shows so the loop body never executes. So the
// structural property the review called the blocker is asserted against the real
// source instead — same technique as
// tests/unit/audit-imageless-scored-shows-push.test.mjs, which test.yml documents
// as "asserts the loop is gone by reading this file's real source".
test('the budget is checked in the INNER outlet loop, before the SERP call', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const innerStart = src.indexOf('for (const outlet of missing) {');
  assert.ok(innerStart > 0, 'inner outlet loop not found — did the loop get renamed?');

  // Bound the inner loop at the line that closes it (the outer loop's own
  // maxSearches break sits immediately after).
  const innerEnd = src.indexOf('if (totalSearches >= opts.maxSearches) break;', innerStart);
  assert.ok(innerEnd > innerStart, 'could not delimit the inner outlet loop');
  const innerBody = src.slice(innerStart, innerEnd);

  assert.ok(
    innerBody.includes('timeBudget.exceeded()'),
    'the budget must be checked per-OUTLET, not only per-show: one show can hold the ' +
      'whole --max-searches allowance (80 on opening night, ~10s each ≈ 13min), so a ' +
      'per-show-only check lets one in-flight show overshoot and blow the job cap anyway',
  );

  // It must gate BEFORE the SERP call, otherwise overshoot is unbounded.
  const budgetAt = innerBody.indexOf('timeBudget.exceeded()');
  const serpAt = innerBody.indexOf('discoverCorrectUrl');
  assert.ok(serpAt > 0, 'expected the SERP call (discoverCorrectUrl) inside the inner loop');
  assert.ok(
    budgetAt < serpAt,
    'the budget check must precede the SERP call so overshoot is bounded to one call',
  );
});

test('the budget break falls through to the summary rather than exiting the process', () => {
  const src = fs.readFileSync(SRC, 'utf8');
  const mainStart = src.indexOf('async function main()');
  const mainBody = src.slice(mainStart);
  // A process.exit(0) on the budget path would skip the summary block, and in the
  // workflow it would also skip nothing useful — but it hides how much was done.
  const budgetBlocks = mainBody.split('timeBudget.exceeded()').slice(1);
  assert.ok(budgetBlocks.length >= 2, 'expected both the inner and outer budget checks');
  for (const block of budgetBlocks) {
    const next200 = block.slice(0, 200);
    assert.ok(
      !/process\.exit\(/.test(next200),
      `budget path must break, not process.exit — found: ${next200.slice(0, 120)}`,
    );
  }
  assert.ok(mainBody.includes('=== Summary ==='), 'summary block must still be reachable');
});

test('the gather-reviews workflow passes the equals form to this script', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'gather-reviews.yml'), 'utf8');
  assert.match(
    wf,
    /--time-budget-min=\d+/,
    'outlet-serp must pass --time-budget-min=N (equals), not the space form',
  );
  assert.ok(
    !/--time-budget-min\s+\d/.test(wf),
    'the space form would parse as 0 and silently disable the budget',
  );
});

test('the outlet-serp job cap leaves room for setup + budget + push', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'gather-reviews.yml'), 'utf8');
  const budget = Number(wf.match(/--time-budget-min=(\d+)/)[1]);
  const outletJob = wf.slice(wf.indexOf('\n  outlet-serp:'), wf.indexOf('\n  gather-reviews:'));
  const cap = Number(outletJob.match(/timeout-minutes:\s*(\d+)/)[1]);
  // Measured in run 35497194379: 3m03s setup + 1m15s push. Keep >=6min of headroom
  // above the script budget so the if: always() push/ledger steps actually run.
  assert.ok(
    cap - budget >= 6,
    `outlet-serp timeout-minutes (${cap}) must exceed --time-budget-min (${budget}) by >=6min`,
  );
});
