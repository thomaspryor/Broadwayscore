import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { decideLandRetry, MAX_ATTEMPTS } = require('./land-retry-on-cancel.js');

const run = (o = {}) => ({ conclusion: 'cancelled', head_branch: 'land/bro-4234-owner-banner', run_attempt: 1, ...o });
const jobs = (land = {}, checks = {}) => [
  { name: 'Checks', conclusion: 'success', ...checks },
  { name: 'Land', conclusion: 'cancelled', steps: [{ conclusion: 'cancelled' }, { conclusion: 'skipped' }], ...land },
];
const d = (o = {}) => decideLandRetry({ run: run(), jobs: jobs(), branchExists: true, ...o });

test('the 2026-09-28 case: Checks success, Land cancelled while queued → retry', () => {
  assert.deepEqual(d(), { retry: true, reason: 'land-cancelled-while-queued', attempt: 1 });
});
test('Land cancelled mid-work (a step completed) is not replayed', () => {
  assert.equal(d({ jobs: jobs({ steps: [{ conclusion: 'success' }, { conclusion: 'cancelled' }] }) }).reason, 'land-started-work');
});
test('Checks not green → no retry', () => {
  assert.equal(d({ jobs: jobs({}, { conclusion: 'cancelled' }) }).retry, false);
  assert.equal(d({ jobs: jobs({}, { conclusion: 'failure' }) }).retry, false);
});
test('run not cancelled / not a land branch / branch gone → no retry', () => {
  assert.equal(d({ run: run({ conclusion: 'success' }) }).retry, false);
  assert.equal(d({ run: run({ head_branch: 'main' }) }).reason, 'not-a-land-branch');
  assert.equal(d({ branchExists: false }).reason, 'branch-gone');
});
test('attempt budget bounds the loop', () => {
  assert.equal(d({ run: run({ run_attempt: MAX_ATTEMPTS }) }).reason, 'attempts-exhausted');
  assert.equal(d({ run: run({ run_attempt: MAX_ATTEMPTS - 1 }) }).retry, true);
});
test('Land job that succeeded/failed is not retried', () => {
  assert.equal(d({ jobs: jobs({ conclusion: 'failure' }) }).retry, false);
  assert.equal(d({ jobs: [{ name: 'Checks', conclusion: 'success' }] }).reason, 'no-land-job');
});
test('workflow wiring: triggers on Land completion and calls the real script', () => {
  const y = readFileSync(new URL('../../.github/workflows/land-retry-cancelled.yml', import.meta.url), 'utf8');
  assert.match(y, /workflows: \['Land'\]/);
  assert.match(y, /conclusion == 'cancelled'/);
  assert.match(y, /scripts\/land-retry-cancelled\.js/);
  assert.match(y, /actions: write/);
  const lib = readFileSync(new URL('../land-retry-cancelled.js', import.meta.url), 'utf8');
  assert.match(lib, /land-retry-on-cancel/);
});
