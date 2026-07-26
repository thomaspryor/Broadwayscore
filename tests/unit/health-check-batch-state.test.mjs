// Task #547: index.ts's --batch mode (task #516) writes batchInFlight state to
// data/collection-state/scoring-batch-state.json but nothing read it — a batch
// that stalls past the poll budget scored zero new reviews with no distinct
// signal from "nothing needed scoring". This covers the age-threshold logic
// that promotes stale batch state into the daily digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { batchStateResult } = require('../../scripts/health-check.js');

function hoursAgoIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test('batchStateResult: absent state is pass, "no batch in flight"', () => {
  const result = batchStateResult(null);
  assert.equal(result.status, 'pass');
  assert.match(result.message, /no batch in flight/i);
});

test('batchStateResult: 1h-old batch is pass', () => {
  const result = batchStateResult({ submittedAt: hoursAgoIso(1), itemCount: 392 });
  assert.equal(result.status, 'pass');
  assert.match(result.message, /392 reviews/);
});

test('batchStateResult: 14h-old batch is warn and carries age + itemCount', () => {
  const result = batchStateResult({ submittedAt: hoursAgoIso(14), itemCount: 392 });
  assert.equal(result.status, 'warn');
  assert.match(result.message, /14h/);
  assert.match(result.message, /392 reviews/);
  assert.match(result.message, /next run resumes polling/);
});

test('batchStateResult: 30h-old batch is error (past the 24h vendor-expiry window)', () => {
  const result = batchStateResult({ submittedAt: hoursAgoIso(30), itemCount: 392 });
  assert.equal(result.status, 'error');
  assert.match(result.message, /392 reviews/);
  assert.ok(result.hint, 'error result should include a hint');
});

test('batchStateResult: 12h boundary is still pass, 12.5h flips to warn', () => {
  assert.equal(batchStateResult({ submittedAt: hoursAgoIso(12), itemCount: 1 }).status, 'pass');
  assert.equal(batchStateResult({ submittedAt: hoursAgoIso(12.5), itemCount: 1 }).status, 'warn');
});

test('batchStateResult: 24h boundary is still warn, 24.5h flips to error', () => {
  assert.equal(batchStateResult({ submittedAt: hoursAgoIso(24), itemCount: 1 }).status, 'warn');
  assert.equal(batchStateResult({ submittedAt: hoursAgoIso(24.5), itemCount: 1 }).status, 'error');
});

test('batchStateResult: unparseable submittedAt is warn, not a crash', () => {
  const result = batchStateResult({ submittedAt: 'not-a-date', itemCount: 5 });
  assert.equal(result.status, 'warn');
  assert.match(result.message, /unparseable/i);
});

test('batchStateResult: missing itemCount defaults to 0 rather than throwing', () => {
  const result = batchStateResult({ submittedAt: hoursAgoIso(1) });
  assert.equal(result.status, 'pass');
  assert.match(result.message, /0 reviews/);
});
