import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { evaluateRepairReport } = createRequire(import.meta.url)('./bww-digit-outlet-repair-check');

const ok = { archivesScanned: 3, writtenFiles: 7, manualReview: [], repairs: Array(7).fill({ status: 'repaired' }) };
test('dry run passes when archives were scanned', () => assert.equal(evaluateRepairReport({ archivesScanned: 1 }, { write: false }), null));
test('empty archive fails even as a dry run', () => assert.match(evaluateRepairReport({ archivesScanned: 0 }, { write: false }), /no BWW archives/));
test('exact expected write passes', () => assert.equal(evaluateRepairReport(ok, { write: true, expect: 7 }), null));
test('count mismatch fails', () => assert.match(evaluateRepairReport(ok, { write: true, expect: 8 }), /expected 8/));
test('refused repair fails', () => {
  const r = { ...ok, repairs: [...ok.repairs.slice(1), { status: 'refused' }] };
  assert.match(evaluateRepairReport(r, { write: true, expect: 7 }), /not applied \(refused\)/);
});
test('unrelated manual review entries do not fail the run', () => {
  assert.equal(evaluateRepairReport({ ...ok, manualReview: [{ reason: 'unreadable-article-body' }] }, { write: true, expect: 7 }), null);
});
test('write-guard refusal in manualReview fails', () => {
  assert.match(evaluateRepairReport({ ...ok, manualReview: [{ reason: 'write-guard-refused-repair' }] }, { write: true, expect: 7 }), /refused/);
});
