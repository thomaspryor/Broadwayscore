import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { foldCanaryStage, assessCanaryRow } = createRequire(import.meta.url)('./autofix-canary.js');
const now = new Date('2026-11-25T13:00:00Z');
const entries = [{ event: 'card-file-failed', date: '2026-11-24' }];
test('card-file-failed folds to file-failed, not not-filed', () => {
  assert.equal(foldCanaryStage({ dateStr: '2026-11-24', canaryLedgerEntries: entries, dispatchLedgerEntries: [] }).stage, 'file-failed');
  assert.equal(foldCanaryStage({ dateStr: '2026-11-24', canaryLedgerEntries: [{ event: 'x', date: '2026-11-20' }], dispatchLedgerEntries: [] }).stage, 'not-filed');
});
test('file-failed is a warn, not a pipeline-broken error', () => {
  assert.equal(assessCanaryRow({ canaryLedgerEntries: entries, dispatchLedgerEntries: [], now }).status, 'warn');
});
