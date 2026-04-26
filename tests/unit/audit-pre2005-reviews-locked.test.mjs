/**
 * Verifies audit-pre2005-reviews.js's flag-write paths preserve PROTECTED
 * fields on locked files (S1-T3b). The cross-show MOVE path is explicitly
 * out of scope (TOPOLOGY marker) and tracked in a separate Notion card.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pre2005-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('audit-pre2005-reviews flag-write paths (S1-T3b)', () => {
  test('locked file resists wrongProduction flag flip from duplicate-at-target branch', () => {
    const filePath = path.join(tmpDir, 'locked-dup.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      wrongProduction: false,
      assignedScore: 88,
    }, null, 2));

    // Mirror the script's "duplicate exists at target" flag-write logic.
    const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    reviewData.wrongProduction = true;
    reviewData.auditSuggested = 'wrongProduction';
    reviewData.auditReason = 'pre2005-audit: duplicate exists at giant-2026';
    reviewData.auditConfidence = 'high';
    reviewData.auditDate = '2026-04-26';
    const result = safeWriteReview(filePath, reviewData);

    assert.equal(result.lockedSkipped, true);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(written.wrongProduction, false);
    assert.equal(written.assignedScore, 88);
  });

  test('locked file resists auditSuggested flag write from else-branch', () => {
    const filePath = path.join(tmpDir, 'locked-flag.json');
    fs.writeFileSync(filePath, JSON.stringify({
      _locked: true,
      assignedScore: 95,
      fullText: 'Real review text — manually verified',
    }, null, 2));

    // Mirror the script's else-branch flag-write logic.
    const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    reviewData.auditSuggested = 'wrongProduction';
    reviewData.auditReason = 'text mentions revival cast';
    reviewData.auditConfidence = 'high';
    reviewData.auditDate = '2026-04-26';
    safeWriteReview(filePath, reviewData);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    // PROTECTED fields preserved.
    assert.equal(written.assignedScore, 95);
    assert.equal(written.fullText, 'Real review text — manually verified');
    // Non-PROTECTED audit-trail fields are allowed to land (they are
    // forensic metadata, not data the lock guards).
    assert.equal(written.auditSuggested, 'wrongProduction');
  });

  test('TOPOLOGY marker is present on the cross-show MOVE write', () => {
    const src = fs.readFileSync(
      path.resolve('scripts/audit-pre2005-reviews.js'),
      'utf8',
    );
    assert.ok(
      src.includes('TOPOLOGY: file moves do not honor _locked'),
      'audit-pre2005-reviews.js must mark the MOVE write with a TOPOLOGY comment',
    );
  });
});
