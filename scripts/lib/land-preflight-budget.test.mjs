import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKFLOW_CHECK_TIMEOUT_SECONDS, WORKFLOW_BATCH_TIMEOUT_MS, fastTestsPhaseBudget, fastTestsCheck } from './land-preflight.mjs';

test('workflow checks can finish and fast tests fit the hook budget', () => {
  assert.ok(WORKFLOW_CHECK_TIMEOUT_SECONDS >= 70);
  assert.ok(WORKFLOW_BATCH_TIMEOUT_MS > WORKFLOW_CHECK_TIMEOUT_SECONDS * 1000);
  assert.equal(fastTestsPhaseBudget(0), 80000);
  assert.equal(fastTestsPhaseBudget(125000), 37500);
  assert.equal(fastTestsPhaseBudget(250000), 0);
  assert.ok(125000 + 2 * fastTestsPhaseBudget(125000) + 40000 <= 240000);
});

test('fast test runner uses the remaining budget and warns when there is too little', () => {
  let invocation;
  const seams = { changedFiles: ['scripts/lib/land-preflight.mjs'], run: (_cmd, args, options) => {
    invocation = { args, options };
    return { status: 0, stdout: '{"status":"clean"}' };
  } };
  const options = { root: process.cwd(), rebase: { status: 'clean', tip: 'HEAD' }, env: {}, seams };
  assert.equal(fastTestsCheck({ ...options, phaseMs: 37500 }).status, 'clean');
  assert.equal(invocation.args.at(-1), '37500');
  assert.equal(invocation.options.timeout, 115000);
  invocation = null;
  const skipped = fastTestsCheck({ ...options, phaseMs: 14999 });
  assert.equal(skipped.status, 'skip');
  assert.match(skipped.warning, /budget/);
  assert.equal(invocation, null);
});
