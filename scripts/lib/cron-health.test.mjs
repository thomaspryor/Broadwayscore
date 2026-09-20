import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyJob, minutesBetween } = require('./cron-health.js');

test('a successful job classifies as success', () => {
  assert.equal(classifyJob({ conclusion: 'success' }, {}), 'success');
});

test('a skipped job classifies as skipped', () => {
  assert.equal(classifyJob({ conclusion: 'skipped' }, {}), 'skipped');
});

test('a cancelled job near its declared timeout is timeout-cancelled', () => {
  const job = {
    name: 'checklist',
    conclusion: 'cancelled',
    startedAt: '2026-09-14T00:00:00Z',
    completedAt: '2026-09-14T00:18:00Z', // 18 of 20 min = 0.9 >= 0.85
  };
  assert.equal(classifyJob(job, { checklist: 20 }), 'timeout-cancelled (18min vs 20min timeout)');
});

test('a cancelled job well under its timeout is not timeout-shaped', () => {
  const job = {
    name: 'checklist',
    conclusion: 'cancelled',
    startedAt: '2026-09-14T00:00:00Z',
    completedAt: '2026-09-14T00:05:00Z', // 5 of 20 min
  };
  assert.equal(
    classifyJob(job, { checklist: 20 }),
    'cancelled (not timeout-shaped — check for a concurrency cancel or manual stop)'
  );
});

test('a cancelled job with no known timeout for its name is not timeout-shaped', () => {
  const job = { name: 'unmapped-job', conclusion: 'cancelled', startedAt: 'x', completedAt: 'y' };
  assert.equal(
    classifyJob(job, { checklist: 20 }),
    'cancelled (not timeout-shaped — check for a concurrency cancel or manual stop)'
  );
});

test('a failed job with a failing Commit/Push step is push-contention', () => {
  const job = {
    conclusion: 'failure',
    steps: [
      { name: 'Checkout', conclusion: 'success' },
      { name: 'Commit opening night state (apiFallbackSafe)', conclusion: 'failure' },
    ],
  };
  assert.equal(classifyJob(job, {}), 'push-contention (failed step: "Commit opening night state (apiFallbackSafe)")');
});

test('a failed job with a failing Push-prefixed step is also push-contention (case-insensitive)', () => {
  const job = {
    conclusion: 'failure',
    steps: [{ name: 'push core data', conclusion: 'failure' }],
  };
  assert.equal(classifyJob(job, {}), 'push-contention (failed step: "push core data")');
});

test('a failed job with an unrelated failing step is "other failure" with the step name', () => {
  const job = {
    conclusion: 'failure',
    steps: [{ name: 'Run opening night checklist', conclusion: 'failure' }],
  };
  assert.equal(classifyJob(job, {}), 'other failure (failed step: "Run opening night checklist")');
});

test('a failed job with no per-step data is a bare "other failure"', () => {
  assert.equal(classifyJob({ conclusion: 'failure' }, {}), 'other failure');
});

test('an unrecognized conclusion passes through as-is', () => {
  assert.equal(classifyJob({ conclusion: 'action_required' }, {}), 'action_required');
});

test('a missing conclusion classifies as unknown', () => {
  assert.equal(classifyJob({}, {}), 'unknown');
});

test('minutesBetween computes elapsed minutes', () => {
  assert.equal(minutesBetween('2026-09-14T00:00:00Z', '2026-09-14T00:10:00Z'), 10);
});

test('minutesBetween is null-safe for missing or unparsable timestamps', () => {
  assert.equal(minutesBetween(null, '2026-09-14T00:10:00Z'), null);
  assert.equal(minutesBetween('2026-09-14T00:00:00Z', undefined), null);
  assert.equal(minutesBetween('not-a-date', '2026-09-14T00:10:00Z'), null);
});
