import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseArgs, evaluate, parseCount } = require('./check-workflow-run-status.js');
const { isSafeCheckCommand } = require('./lib/autonomous-triage-core.js');

const r = (c) => ({ conclusion: c, status: 'completed', url: 'u' });

test('parseArgs reads --workflow/--expect', () => {
  assert.deepEqual(parseArgs(['--workflow=data-health-check.yml', '--expect=success']), { workflow: 'data-health-check.yml', expect: 'success' });
});

// BRO-3320 original intent: most recent data-health-check.yml run succeeded.
test('BRO-3320: single most-recent run matches --expect', () => {
  assert.equal(evaluate([r('success'), r('failure')], { expect: 'success' }).ok, true);
  assert.equal(evaluate([r('failure'), r('success')], { expect: 'success' }).ok, false);
});

test('no runs is a failure, never vacuous', () => {
  assert.equal(evaluate([], { expect: 'success' }).ok, false);
  assert.equal(evaluate([], { expect: 'cancelled', limit: 20, maxMatch: 0 }).ok, false);
});

test('BRO-3145: 3 consecutive non-failure = failure max 0 of last 3', () => {
  assert.equal(evaluate([r('success'), r('success'), r('success')], { expect: 'failure', limit: 3, maxMatch: 0 }).ok, true);
  assert.equal(evaluate([r('success'), r('failure'), r('success')], { expect: 'failure', limit: 3, maxMatch: 0 }).ok, false);
});

test('BRO-3197: >=K successes in last N; short history cannot satisfy min-match', () => {
  const runs = [r('success'), r('failure'), r('success'), r('success'), r('failure')];
  assert.equal(evaluate(runs, { expect: 'success', limit: 5, minMatch: 3 }).ok, true);
  assert.equal(evaluate(runs, { expect: 'success', limit: 5, minMatch: 4 }).ok, false);
  assert.equal(evaluate([r('success'), r('success')], { expect: 'success', limit: 3, minMatch: 2 }).ok, false);
});

test('BRO-3152/3388: failure/cancelled count caps', () => {
  const runs = [r('failure'), r('success'), r('success'), r('success'), r('success')];
  assert.equal(evaluate(runs, { expect: 'failure', limit: 5, maxMatch: 1 }).ok, true);
  assert.equal(evaluate(runs, { expect: 'failure', limit: 5, maxMatch: 0 }).ok, false);
  assert.equal(evaluate([r('success')], { expect: 'cancelled', limit: 20, maxMatch: 0 }).ok, true);
});

test('parseCount validates bounds', () => {
  assert.equal(parseCount(undefined, 'limit', 1), undefined);
  assert.equal(parseCount('5', 'limit', 1), 5);
  assert.throws(() => parseCount('0', 'limit', 1));
  assert.throws(() => parseCount('abc', 'limit', 1));
  assert.throws(() => parseCount('999', 'limit', 1));
});

test('SAFE_CHECK_FORMS admits the single and multi-run shapes, refuses raw gh run list', () => {
  const base = 'node scripts/check-workflow-run-status.js --workflow=data-health-check.yml --expect=success';
  assert.equal(isSafeCheckCommand(base), true);
  assert.equal(isSafeCheckCommand(`${base} --limit=5 --min-match=3`), true);
  assert.equal(isSafeCheckCommand('node scripts/check-workflow-run-status.js --workflow=x.yml --expect=failure --limit=5 --max-match=1'), true);
  assert.equal(isSafeCheckCommand(`${base} --limit=abc`), false);
  assert.equal(isSafeCheckCommand('gh run list --workflow=data-health-check.yml --limit 1'), false);
});
