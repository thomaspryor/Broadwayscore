/**
 * Verifies classify-wrong-show.js's 5 flag-write paths preserve PROTECTED
 * fields on locked files (S1-T3d). Writes target wrongShow + wrongShowReason
 * (PROTECTED) plus wsClassified + wsClassifiedDate (audit metadata).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-ws-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('classify-wrong-show locked-file behavior (S1-T3d)', () => {
  test('locked file with wrongShow:false resists high-confidence flag flip', () => {
    const filePath = path.join(tmpDir, 'locked-high-conf.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      wrongShow: false,
      wrongShowReason: 'manually verified — correct show',
      assignedScore: 88,
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.wrongShow = true;
    data.wrongShowReason = 'LLM: review is actually about a different show';
    data.wsClassified = 'wrong_show';
    data.wsClassifiedDate = '2026-04-26';
    const result = safeWriteReview(filePath, data);

    assert.equal(result.lockedSkipped, true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongShow, false);
    assert.equal(written.wrongShowReason, 'manually verified — correct show');
    assert.equal(written.assignedScore, 88);
  });

  test('locked file with wrongShow:false resists medium-confidence flag flip', () => {
    const filePath = path.join(tmpDir, 'locked-med-conf.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      wrongShow: false,
      assignedScore: 70,
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.wrongShow = true;
    data.wrongShowReason = 'LLM (medium): unclear';
    data.wsClassified = 'wrong_show';
    data.wsClassifiedDate = '2026-04-26';
    safeWriteReview(filePath, data);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongShow, false);
    assert.equal(written.assignedScore, 70);
  });

  test('locked file with no wrongShow can pick up audit-trail metadata', () => {
    // No existing PROTECTED value → lockedOverride doesn't apply, audit metadata lands.
    const filePath = path.join(tmpDir, 'locked-no-prior.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 95,
    }, null, 2));

    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.wsClassified = 'correct';
    data.wsClassifiedDate = '2026-04-26';
    safeWriteReview(filePath, data);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // PROTECTED preserved.
    assert.equal(written.assignedScore, 95);
    // Audit metadata can land — non-PROTECTED, no existing value.
    assert.equal(written.wsClassified, 'correct');
  });
});
