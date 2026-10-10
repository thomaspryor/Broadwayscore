/**
 * Tests for per-file protectedFields override in review-write-guard.js
 * Uses real functions via require() per §15 pattern.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { safeWriteReview, checkForDataLoss, getEffectiveProtectedFields, PROTECTED_FIELDS } = require('../../scripts/lib/review-write-guard');

let tmpDir;
let tmpFile;

function writeTmp(data) {
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
}

function readTmp() {
  return JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
}

describe('getEffectiveProtectedFields', () => {
  it('returns global PROTECTED_FIELDS when existingData is null', () => {
    const result = getEffectiveProtectedFields(null);
    for (const f of PROTECTED_FIELDS) {
      assert.ok(result.includes(f), `Expected ${f} in result`);
    }
  });

  it('includes protectedFields itself always', () => {
    const result = getEffectiveProtectedFields(null);
    assert.ok(result.includes('protectedFields'));
  });

  it('unions per-file protectedFields with global list', () => {
    const result = getEffectiveProtectedFields({ protectedFields: ['myCustomFlag'] });
    assert.ok(result.includes('myCustomFlag'));
    assert.ok(result.includes('humanReviewScore')); // still has global fields
  });

  it('ignores non-array protectedFields in file', () => {
    const result = getEffectiveProtectedFields({ protectedFields: 'not-an-array' });
    // Should not throw; falls back to global only
    assert.ok(result.includes('humanReviewScore'));
  });
});

describe('safeWriteReview — per-file protectedFields', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfl-test-'));
    tmpFile = path.join(tmpDir, 'review.json');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('preserves per-file protected field when downstream write omits it', () => {
    writeTmp({ protectedFields: ['customFlag'], customFlag: 'keep-me', title: 'Test Show' });
    safeWriteReview(tmpFile, { title: 'Test Show' }); // omits customFlag
    const after = readTmp();
    assert.strictEqual(after.customFlag, 'keep-me');
  });

  it('allows force=true to overwrite a per-file protected field', () => {
    writeTmp({ protectedFields: ['customFlag'], customFlag: 'keep-me', title: 'Test Show' });
    safeWriteReview(tmpFile, { title: 'Updated' }, { force: true });
    const after = readTmp();
    assert.strictEqual(after.customFlag, undefined);
  });

  it('preserves protectedFields array itself when downstream write omits it', () => {
    writeTmp({ protectedFields: ['customFlag'], customFlag: 'keep-me' });
    safeWriteReview(tmpFile, { customFlag: 'keep-me' }); // omits protectedFields key
    const after = readTmp();
    assert.deepStrictEqual(after.protectedFields, ['customFlag']);
  });

  it('behaves correctly when file has no protectedFields (global PROTECTED_FIELDS only)', () => {
    writeTmp({ humanReviewScore: 99, title: 'No per-file lock' });
    safeWriteReview(tmpFile, { title: 'No per-file lock' }); // omits humanReviewScore
    const after = readTmp();
    assert.strictEqual(after.humanReviewScore, 99);
  });

  it('does not clobber a per-file protected field with null from newData', () => {
    writeTmp({ protectedFields: ['foo'], foo: 'bar' });
    safeWriteReview(tmpFile, { foo: null }); // explicitly null — treated as "omit"
    const after = readTmp();
    assert.strictEqual(after.foo, 'bar');
  });

  it('global PROTECTED_FIELDS members are protected even if not in per-file array', () => {
    writeTmp({ protectedFields: ['somethingElse'], assignedScore: 75 });
    safeWriteReview(tmpFile, { somethingElse: 'x' }); // omits assignedScore
    const after = readTmp();
    assert.strictEqual(after.assignedScore, 75);
  });

  it('returns preserved list that includes per-file fields', () => {
    writeTmp({ protectedFields: ['myLock'], myLock: 'value' });
    const { preserved } = safeWriteReview(tmpFile, {});
    assert.ok(preserved.includes('myLock'), `Expected myLock in preserved: ${preserved}`);
  });

  it('force=true on protectedFields itself allows clearing the array', () => {
    writeTmp({ protectedFields: ['customFlag'], customFlag: 'keep' });
    safeWriteReview(tmpFile, { customFlag: 'keep' }, { force: true });
    const after = readTmp();
    assert.strictEqual(after.protectedFields, undefined);
  });
});

describe('checkForDataLoss — per-file protectedFields', () => {
  let lossDir;
  before(() => {
    lossDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfl-loss-test-'));
    tmpFile = path.join(lossDir, 'review2.json');
  });

  after(() => {
    fs.rmSync(lossDir, { recursive: true, force: true });
  });

  it('reports loss of per-file protected field', () => {
    writeTmp({ protectedFields: ['myFlag'], myFlag: 'value' });
    const losses = checkForDataLoss(tmpFile, { title: 'New Data' });
    assert.ok(losses.includes('myFlag'), `Expected myFlag in losses: ${losses}`);
  });

  it('reports protectedFields itself as would-be-lost', () => {
    writeTmp({ protectedFields: ['myFlag'], myFlag: 'value' });
    const losses = checkForDataLoss(tmpFile, { myFlag: 'value' }); // omits protectedFields
    assert.ok(losses.includes('protectedFields'), `Expected protectedFields in losses: ${losses}`);
  });

  it('returns empty array when no data would be lost', () => {
    writeTmp({ protectedFields: ['myFlag'], myFlag: 'value' });
    const losses = checkForDataLoss(tmpFile, { protectedFields: ['myFlag'], myFlag: 'value' });
    assert.strictEqual(losses.length, 0);
  });
});
