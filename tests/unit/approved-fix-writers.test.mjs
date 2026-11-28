import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { approvedFixBinding } = require('../../scripts/lib/approved-fix-flag');
const { shouldClearOrphanedDuplicatePointer, findUnjustifiedHealClears, buildHealClearReason, findChainPointersThrough } = require('../../scripts/lib/orphaned-duplicate-pointer-heal');

function approve(record, field, newValue, at = '2026-11-08T00:00:00Z') {
  record.approvedFixes = [...(record.approvedFixes || []), { field, newValue, at, boundTo: approvedFixBinding(record) }];
  return record;
}
const body = 'A substantive theatre review. '.repeat(50);

test('BRO-7174: orphan heal keeps a bound approved pointer while its target is invalid', () => {
  const loser = approve({ url: 'https://example.org/review', fullText: body, duplicateOf: 'target.json' }, 'duplicateOf', 'target.json');
  assert.equal(shouldClearOrphanedDuplicatePointer(loser, { wrongShow: true }), false);
  loser.fullText += ' Changed article.';
  assert.equal(shouldClearOrphanedDuplicatePointer(loser, { wrongShow: true }), true);
});

const { canChangeApprovedField, canRecoverReview, canRepairCircularPair } = require('../../scripts/lib/approved-fix-writer-guards');
const { approvedFixDriftResults } = require('../../scripts/lib/approved-fix-drift-health');

test('circular-pair writer preserves the approved canonical pointer, but can keep an approved loser', () => {
  const canonical = approve({ duplicateOf: 'other.json' }, 'duplicateOf', 'other.json');
  const loser = { duplicateOf: 'canonical.json' };
  assert.equal(canRepairCircularPair(canonical, loser, 'canonical.json'), false);
  assert.equal(canRepairCircularPair({}, approve(loser, 'duplicateOf', 'canonical.json'), 'canonical.json'), true);
  assert.equal(canRepairCircularPair({}, approve({ duplicateOf: null }, 'duplicateOf', null), 'canonical.json'), false);
  assert.equal(canRepairCircularPair({ _locked: true }, {}, 'canonical.json'), false);
});

for (const field of ['wrongShow', 'wrongProduction']) {
  test(`recovery writer keeps approved ${field}, and lets changed content be re-evaluated`, () => {
    const record = approve({ [field]: true, fullText: body }, field, true);
    assert.equal(canRecoverReview(record), false);
    record.fullText += ' New content.';
    assert.equal(canRecoverReview(record), true);
    assert.equal(canRecoverReview({ [field]: true }), true);
    assert.equal(canRecoverReview({ _locked: true, [field]: true }), false);
  });
}

test('latest approval wins, including explicit clears and legacy stamps', () => {
  const record = approve({ wrongShow: true }, 'wrongShow', true);
  approve(record, 'wrongShow', null, '2026-11-09T00:00:00Z');
  assert.equal(canRecoverReview(record), true);
  assert.equal(canChangeApprovedField(record, 'wrongShow', true), false);
  assert.equal(canRecoverReview({ wrongShow: true, approvedFixes: [{ field: 'wrongShow', newValue: true }] }), false);
  assert.equal(canRecoverReview({ wrongShow: true, approvedFixes: { field: 'wrongShow' } }), true);
  assert.equal(canRecoverReview({ wrongShow: true, approvedFixes: [null] }), true);
});

function clearedRecords() {
  return [
    { file: 'loser.json', data: { url: 'https://example.org/review', fullText: body,
      duplicateClearReason: buildHealClearReason('2026-11-08', 'target.json', 'test') } },
    { file: 'target.json', data: { url: 'https://example.org/review', fullText: body } },
  ];
}

test('orphan retraction restores an approved pointer once the target recovers', () => {
  const records = clearedRecords();
  approve(records[0].data, 'duplicateOf', 'target.json');
  assert.equal(findUnjustifiedHealClears(records).length, 1);
  records[1].data.wrongShow = true;
  assert.equal(findUnjustifiedHealClears(records).length, 0);
});

test('orphan retraction respects a newer approved clear and a locked file', () => {
  for (const lock of ['approval', 'file']) {
    const records = clearedRecords();
    if (lock === 'approval') approve(records[0].data, 'duplicateOf', null);
    else records[0].data._locked = true;
    assert.deepEqual(findUnjustifiedHealClears(records), []);
  }
});

test('chain flattening never retargets an approved pointer', () => {
  const records = clearedRecords();
  records[0].data.duplicateOf = 'target.json';
  records.push({ file: 'chain.json', data: { url: records[0].data.url, duplicateOf: 'loser.json' } });
  assert.equal(findChainPointersThrough(records, 'loser.json').length, 1);
  approve(records[2].data, 'duplicateOf', 'loser.json');
  assert.deepEqual(findChainPointersThrough(records, 'loser.json'), []);
});

for (const count of [0, 2]) {
  test(`digest carries unexplainedCount=${count} as ${count ? 'warn' : 'pass'}`, () => {
    const [row] = approvedFixDriftResults({ status: 0, output: JSON.stringify({ unexplainedCount: count, scannedWithApprovedFixes: 2773 }) });
    assert.equal(row.status, count ? 'warn' : 'pass');
    assert.match(row.message, new RegExp(`^${count} unexplained`));
  });
}

test('digest warns on failed, empty or malformed scans', () => {
  for (const run of [undefined, { status: 1, output: '{}' }, { status: 0, output: 'oops' },
    { status: 0, output: '{"unexplainedCount":0,"scannedWithApprovedFixes":0}' },
    { status: 0, output: '{"unexplainedCount":-1,"scannedWithApprovedFixes":1}' }]) {
    assert.equal(approvedFixDriftResults(run)[0].status, 'warn');
  }
});
