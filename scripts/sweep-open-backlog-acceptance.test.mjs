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
    eligibleCandidates: 3,
    fetchTruncated: false,
    fetchError: null,
    checkoutSha: 'deadbeef',
    results: [
      { cardId: 'BRO-1', name: 'A', verifyCmd: 'node --test a.test.mjs', status: 'pass', detail: null },
      { cardId: 'BRO-2', name: 'B', verifyCmd: 'node --test b.test.mjs', status: 'fail', detail: 'assertion failed' },
      { cardId: 'BRO-3', name: 'C', verifyCmd: 'node --test c.test.mjs', status: 'unverifiable', detail: 'no node_modules' },
    ],
  });
  assert.equal(report.checked, 3);
  assert.equal(report.totalCandidates, 87);
  assert.equal(report.eligibleCandidates, 3);
  assert.equal(report.shadow, true);
  assert.equal(report.checkoutSha, 'deadbeef');
  assert.equal(report.truncated, false, 'eligible === checked, so no selection truncation');
  assert.deepEqual(report.counts, { pass: 1, fail: 1, unverifiable: 1 });
  assert.deepEqual(report.alreadyDone, [{ id: 'BRO-1', name: 'A', verifyCmd: 'node --test a.test.mjs', detail: null }]);
  assert.deepEqual(report.failing, [{ id: 'BRO-2', name: 'B', verifyCmd: 'node --test b.test.mjs', detail: 'assertion failed' }]);
  assert.deepEqual(report.unverifiable, [{ id: 'BRO-3', name: 'C', verifyCmd: 'node --test c.test.mjs', detail: 'no node_modules' }]);
});

test('buildReport: a pass detail (e.g. "passed on retry") survives into alreadyDone', () => {
  const report = buildReport({
    generatedAt: '2026-09-16T00:00:00.000Z', totalCandidates: 1, eligibleCandidates: 1, fetchTruncated: false,
    results: [{ cardId: 'BRO-1', name: 'A', verifyCmd: 'node --test a.test.mjs', status: 'pass', detail: 'passed on retry (first run flaked)' }],
  });
  assert.equal(report.alreadyDone[0].detail, 'passed on retry (first run flaked)');
});

test('buildReport: eligibleCandidates > checked marks the report truncated (selection-capped, not just fetch-capped)', () => {
  const report = buildReport({
    generatedAt: '2026-09-16T00:00:00.000Z', totalCandidates: 100, eligibleCandidates: 30, fetchTruncated: false,
    results: [{ cardId: 'BRO-1', name: 'A', verifyCmd: 'node --test a.test.mjs', status: 'pass', detail: null }],
  });
  assert.equal(report.truncated, true, 'only 1 of 30 eligible candidates was checked this run');
});

test('buildReport: no results at all still reports a valid zeroed shape', () => {
  const report = buildReport({ generatedAt: '2026-09-16T00:00:00.000Z', totalCandidates: 0, eligibleCandidates: 0, results: [], fetchTruncated: false });
  assert.deepEqual(report.counts, { pass: 0, fail: 0, unverifiable: 0 });
  assert.deepEqual(report.alreadyDone, []);
  assert.deepEqual(report.failing, []);
  assert.equal(report.truncated, false);
});

test('buildReport: a fetch error is carried through untouched', () => {
  const report = buildReport({ generatedAt: '2026-09-16T00:00:00.000Z', totalCandidates: 0, eligibleCandidates: 0, results: [], fetchTruncated: true, fetchError: '401 unauthorized' });
  assert.equal(report.fetchError, '401 unauthorized');
  assert.equal(report.truncated, true);
});
