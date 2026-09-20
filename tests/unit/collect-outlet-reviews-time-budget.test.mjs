// TESTS-VS-DERIVED-DATA-EXEMPT: structural only — data/shows.json is touched
// solely by fs.existsSync() as a skip-guard (a bare worktree has no core data),
// and no assertion reads or pins any show/review fact. The behavioural test
// drives the CLI with deliberately non-existent show ids (zzz-fake-*), so no
// derived-data value can rot it.
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

  // Mutation-proofed (ship-check finding): the earlier version asserted only that
  // the STRING "timeBudget.exceeded()" appeared before "discoverCorrectUrl", which
  // still passed after deleting the `break;` and after `if (false && ...)`. It
  // proved text position, not that anything stops. Require the guard to actually
  // break.
  // Brace-match the guard's own block rather than regexing to the next `}` — the
  // log line contains `${...}` template placeholders, so a `[^}]*` match stops
  // inside the string and gives a false negative.
  const guardAt = innerBody.search(/if\s*\(\s*timeBudget\.exceeded\(\)\s*\)\s*\{/);
  assert.ok(
    guardAt >= 0,
    'the budget must be checked per-OUTLET: one show can hold the whole ' +
      '--max-searches allowance (80 on opening night, ~10s each ≈ 13min), so a ' +
      'per-show-only check lets one in-flight show overshoot and blow the job cap',
  );
  const openAt = innerBody.indexOf('{', guardAt);
  let depth = 0;
  let closeAt = -1;
  for (let i = openAt; i < innerBody.length; i++) {
    if (innerBody[i] === '{') depth++;
    else if (innerBody[i] === '}') {
      depth--;
      if (depth === 0) { closeAt = i; break; }
    }
  }
  assert.ok(closeAt > openAt, 'could not brace-match the budget guard block');
  assert.match(
    innerBody.slice(openAt, closeAt),
    /\bbreak;/,
    'the budget guard must BREAK, not just log — a guard that logs and continues ' +
      'lets the run overshoot exactly as if the budget were absent',
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

// Behavioural, not textual (ship-check finding: the previous source-text version
// survived deleting both `break;` statements). This drives the real CLI with a
// budget that is already spent and asserts on what it actually DOES.
test('an exhausted budget stops the run, names the partial show, and exits 0', (t) => {
  if (!fs.existsSync(path.join(ROOT, 'data', 'shows.json'))) {
    t.skip('needs core data (checkout-core-data supplies it in CI; absent in a bare worktree)');
    return;
  }
  const res = spawnSync(
    process.execPath,
    [SRC, '--shows', 'zzz-fake-1,zzz-fake-2', '--dry-run', '--time-budget-min=0.0001'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, SCRAPINGBEE_API_KEY: 'test-key' },
    },
  );
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${out.slice(-1200)}`);
  assert.match(out, /Time budget: 0\.0001min/, 'header must surface the budget');
  assert.match(out, /=== Summary ===/, 'summary must still print — the budget path breaks, not exits');
  assert.match(out, /EXCEEDED — run truncated/, 'summary must mark the run as truncated');
});

test('the gather-reviews workflow passes the equals form to this script', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'gather-reviews.yml'), 'utf8');
  assert.match(
    wf,
    /--time-budget-min=\d+/,
    'outlet-serp must pass --time-budget-min=N (equals), not the space form',
  );
  // Strip comments first: the naive check matched the explanatory comment that
  // *documents* the wrong form, so writing the docs would have failed CI
  // (ship-check finding).
  const wfCode = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/--time-budget-min\s+\d/.test(wfCode),
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
