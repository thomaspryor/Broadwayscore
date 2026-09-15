// BRO-3388: gather-reviews.js honours --time-budget-min so a multi-show batch
// exits 0 before the GHA job timeout instead of being SIGKILLed with its
// if: always() push steps skipped (which discarded every SERP discovery).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseTimeBudgetMin, createRunBudget } = require('../../scripts/lib/run-budget.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('parseTimeBudgetMin reads the flag the workflow passes and is disabled when absent', () => {
  assert.equal(parseTimeBudgetMin(['--shows=a,b', '--time-budget-min=35']), 35);
  assert.equal(parseTimeBudgetMin(['--shows=a,b']), 0);
});

test('createRunBudget: a tiny budget is exceeded after it elapses; a zero budget never is', async () => {
  const tiny = createRunBudget(0.001); // 60ms
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(tiny.exceeded(), true);
  assert.equal(createRunBudget(0).exceeded(), false);
});

test('gather-reviews.js stops starting new shows once the budget is spent and exits 0 listing the deferred shows', () => {
  const res = spawnSync(process.execPath, [
    'scripts/gather-reviews.js',
    '--shows=zzz-fake-show-1,zzz-fake-show-2,zzz-fake-show-3',
    '--aggregators-only',
    '--time-budget-min=0.001',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 90_000 });
  const out = `${res.stdout}\n${res.stderr}`;
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}\n${out.slice(-1500)}`);
  assert.match(out, /Time budget \(0\.001min\) exceeded/, out.slice(-1500));
  assert.match(out, /deferring \d+ show\(s\) to next run: .*zzz-fake-show-3/, out.slice(-1500));
});
