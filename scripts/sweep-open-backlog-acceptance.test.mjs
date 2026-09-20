import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseArgs, buildReport } = require('./sweep-open-backlog-acceptance.js');

test('parseArgs: reads flags with and without values', () => {
  assert.deepEqual(parseArgs(['--limit', '10', '--dry-run']), { limit: '10', 'dry-run': true });
});

test('parseArgs: a flag immediately followed by another flag has no value', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--limit', '5']), { 'dry-run': true, limit: '5' });
});

test('buildReport: splits results into pass/fail/unverifiable buckets', () => {
  const report = buildReport({
    generatedAt: '2026-09-16T00:00:00.000Z',
    totalCandidates: 87,
    truncated: false,
    fetchError: null,
    results: [
      { cardId: 'BRO-1', name: 'A', verifyCmd: 'node --test a.test.mjs', status: 'pass', detail: null },
      { cardId: 'BRO-2', name: 'B', verifyCmd: 'node --test b.test.mjs', status: 'fail', detail: 'assertion failed' },
      { cardId: 'BRO-3', name: 'C', verifyCmd: 'node --test c.test.mjs', status: 'unverifiable', detail: 'no node_modules' },
    ],
  });
  assert.equal(report.checked, 3);
  assert.equal(report.totalCandidates, 87);
  assert.deepEqual(report.counts, { pass: 1, fail: 1, unverifiable: 1 });
  assert.deepEqual(report.alreadyDone, [{ id: 'BRO-1', name: 'A', verifyCmd: 'node --test a.test.mjs' }]);
  assert.deepEqual(report.failing, [{ id: 'BRO-2', name: 'B', verifyCmd: 'node --test b.test.mjs', detail: 'assertion failed' }]);
});

test('buildReport: no results at all still reports a valid zeroed shape', () => {
  const report = buildReport({ generatedAt: '2026-09-16T00:00:00.000Z', totalCandidates: 0, results: [], truncated: false });
  assert.deepEqual(report.counts, { pass: 0, fail: 0, unverifiable: 0 });
  assert.deepEqual(report.alreadyDone, []);
  assert.deepEqual(report.failing, []);
});

test('buildReport: a fetch error is carried through untouched', () => {
  const report = buildReport({ generatedAt: '2026-09-16T00:00:00.000Z', totalCandidates: 0, results: [], truncated: true, fetchError: '401 unauthorized' });
  assert.equal(report.fetchError, '401 unauthorized');
  assert.equal(report.truncated, true);
});
